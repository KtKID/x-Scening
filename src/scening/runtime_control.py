"""同home采集进程的本地控制；线程只管理意图，正式数据仍由调度线程提交。"""
from contextlib import contextmanager
from datetime import datetime
import os
from pathlib import Path
import socketserver
import threading
import time
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from scening import runtime_logging


class AnalysisCancelled(RuntimeError):
    """用户取消或旧代次任务结束，调用方保留正式图片并停止后续提交。"""


class SignalCancellation:
    """CLI主线程的信号取消意图；处理信号时只写入幂等布尔标记。

    set可直接注册为SIGINT/SIGTERM处理器，参数由系统提供并忽略。
    is_set供模型等待循环和提交边界读取；所有资源回收由正常运行流执行。
    本对象面向同一主线程的信号重入，跨线程唤醒继续使用threading.Event。
    """
    def __init__(self):
        self.requested = False

    def set(self, *_):
        """记录停止意图；重复调用保持同一状态，避免信号内加锁或等待。"""
        self.requested = True

    def is_set(self):
        """返回当前取消意图，供既有取消事件读取契约使用。"""
        return self.requested


class ControlRequest(BaseModel):
    """本地跨进程请求的唯一契约；pid防止误用上次运行的连接。"""
    model_config = ConfigDict(extra='forbid')
    requestId: str = Field(min_length=1)
    pid: int = Field(strict=True, gt=0)
    action: Literal['status', 'enable-analysis', 'disable-analysis', 'stop']


class ControlReply(BaseModel):
    """控制完成回执；mode对应实际入口，代次用于隔离迟到结果。"""
    model_config = ConfigDict(extra='forbid')
    requestId: str
    pid: int = Field(strict=True, gt=0)
    state: Literal['running', 'stopping', 'stopped']
    analysisEnabled: bool
    epoch: int = Field(strict=True, ge=0)
    ok: bool
    message: str


class RuntimeControl:
    """持有开关、停止和提交锁，独立接收状态/控制请求。

    home为当前已独占锁的数据根，settings来自已校验control配置。
    on_stop只通知采集线程；主线程负责finish，控制线程等待真实完成回执。
    socket为0600，仅当前用户可连接；上下文退出清理本次socket并等待监听线程。
    """
    def __init__(self, home, enabled, settings, on_stop):
        self.path = Path(home) / 'observer.sock'
        self.settings = settings
        self.on_stop = on_stop
        self.lock = threading.RLock()
        self.enabled = enabled
        self.epoch = 0
        self.since = datetime.now().astimezone()
        self.cancelled = threading.Event()
        self.changed = threading.Event()
        self.stopping = threading.Event()
        self.done = threading.Event()
        self.interpreter = None
        self.server = self.thread = None

    def snapshot(self):
        """原子读取当前分析段，调用者用代次核对模型结果及图片采集时间。"""
        with self.lock:
            return self.enabled, self.epoch, self.since, self.cancelled

    @contextmanager
    def commit(self, epoch):
        """检查当前代次并独占短提交段，关闭请求在完整文件提交后取得控制权。"""
        with self.lock:
            if self.stopping.is_set() or not self.enabled or self.epoch != epoch:
                raise AnalysisCancelled('分析已取消，原图保留')
            yield

    def set_interpreter(self, interpreter, epoch):
        """只登记当前段的模型所有者，避免取消与新段初始化交错。"""
        with self.lock:
            if self.epoch != epoch or self.stopping.is_set() or not self.enabled:
                raise AnalysisCancelled('分析段已结束')
            previous = self.interpreter
        if previous is not None and previous is not interpreter and callable(getattr(previous, 'cancel', None)):
            previous.cancel(timeout=self.settings.timeoutSeconds)
        with self.lock:
            if self.epoch != epoch or self.stopping.is_set() or not self.enabled:
                raise AnalysisCancelled('分析段已结束')
            self.interpreter = interpreter

    def request_stop(self):
        """停止优先覆盖开关，唤醒采集和调度，并使所有旧结果失效。"""
        with self.lock:
            self.stopping.set()
            self.cancelled.set()
            self.changed.set()
        self.on_stop()

    def execute(self, request):
        """执行并返回完成回执，耗时取消在锁外等待，使停止和状态始终可达。"""
        deadline = time.monotonic() + self.settings.timeoutSeconds
        error = ''
        try:
            if request.action != 'status':
                runtime_logging.log_event({'stage':'control','result':'received','requestId':request.requestId,
                                           'action':request.action,'pid':os.getpid(),'message':'收到控制请求'})
            if request.pid != os.getpid():
                raise ValueError('采集进程身份已变化')
            model = None
            if request.action == 'stop':
                self.request_stop()
                model = self.interpreter
            elif request.action != 'status':
                with self.lock:
                    if self.stopping.is_set():
                        raise AnalysisCancelled('采集正在停止')
                    enabled = request.action == 'enable-analysis'
                    if enabled != self.enabled:
                        self.cancelled.set()
                        model = self.interpreter
                        self.epoch += 1
                        self.enabled = enabled
                        self.since = datetime.now().astimezone()
                        self.cancelled = threading.Event()
                        self.changed.set()
                    elif not enabled:
                        # 上一次回收失败后，重复关闭仍由原任务所有者继续回收。
                        model = self.interpreter
            if model is not None and callable(getattr(model, 'cancel', None)):
                model.cancel(timeout=max(0, deadline - time.monotonic()))
            if request.action == 'stop' and not self.done.wait(max(0, deadline - time.monotonic())):
                raise TimeoutError('采集停止等待超时，请查看logs')
        except (ValueError, RuntimeError, TimeoutError) as exception:
            error = str(exception)
        if request.action != 'status':
            runtime_logging.log_event({'stage':'control','result':'failed' if error else 'completed',
                                       'requestId':request.requestId,'action':request.action,'pid':os.getpid(),
                                       'elapsedMs':round((time.monotonic()-deadline+self.settings.timeoutSeconds)*1000,2),
                                       'message':error or '控制已生效'})
        with self.lock:
            return ControlReply(requestId=request.requestId, pid=os.getpid(),
                                state='stopped' if self.done.is_set() else 'stopping' if self.stopping.is_set() else 'running',
                                analysisEnabled=self.enabled, epoch=self.epoch, ok=not error,
                                message=error or '运行状态已更新')

    def __enter__(self):
        """取得home锁后创建监听；旧socket名称可安全替换，启动失败传播给运行入口。"""
        owner = self
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                """每条连接处理一条JSON行，异常只关闭当前请求。"""
                self.connection.settimeout(owner.settings.timeoutSeconds)
                try:
                    request = ControlRequest.model_validate_json(self.rfile.readline(65536))
                    reply = owner.execute(request)
                    self.wfile.write((reply.model_dump_json() + '\n').encode())
                except (OSError, ValueError):
                    return
        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True
            block_on_close = False
        self.path.unlink(missing_ok=True)
        self.server = Server(str(self.path), Handler)
        os.chmod(self.path, 0o600)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={'poll_interval': self.settings.pollSeconds}, daemon=True)
        self.thread.start()
        return self

    def finish(self):
        """采集与当前调用真实回收后标记完成，唤醒等待停止的客户端。"""
        self.done.set()

    def __exit__(self, *args):
        """所有退出路径清理本次监听和socket；已发布图片、记录与日志保留。"""
        self.finish()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(self.settings.timeoutSeconds)
        self.path.unlink(missing_ok=True)
