"""运行时控制集成：真实采集线程/JPEG/JSON/模型进程，系统取屏使用合成后端。"""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import signal
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import observe_activity as activity
from scening import runtime_logging
from scening.collector import SensingCollector
from scening.kmh_interpreter import KMHInterpreter
from scening.observer_config import load_config
from scening.runtime_control import ControlRequest, ControlReply, RuntimeControl, AnalysisCancelled
from test_scening import Backend


class RuntimeControlTests(unittest.TestCase):
    """每例独占tmp，验证关闭时真实任务回收以及持续采集和重新分析。"""

    def exercise(self, resume):
        """启动真实主循环；模型首调用忽略TERM，控制线程关闭后可按需重新开启。

        resume为True验证同进程重开及截图连续性；False验证分析中停止的总时限。
        所有控制请求使用正式Pydantic契约，driver异常会通知主循环停止并传播断言。
        """
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='runtime-control-', dir=root / 'tmp') as folder:
            home = Path(folder)
            base = load_config()
            config = base.with_overrides(home=home, screenshotDir=home/'pictures', sampleIntervalSeconds=.001,
                                         summaryIntervalSeconds=1800 if resume else .01,
                                         scening={**base.scening.model_dump(), 'captureFps':50., 'observationIntervalSeconds':.02})
            backend = Backend()
            calls, summaries, errors, durations = [], [], [], {}
            models = []
            worker = home/'model.pid'
            def collector(settings, **kwargs):
                """保留线程、选图与原子图片保存，仅替换系统取屏。"""
                return SensingCollector(settings, backend=backend, app_provider=lambda: ('Probe', 'probe.app'))

            class Model(KMHInterpreter):
                def analyze(self, image, frames=None):
                    """首任务为真实顽固进程；重开后的任务返回有效观察正文。"""
                    calls.append(frames)
                    models.append(self)
                    if len(calls)==1:
                        code="import os,pathlib,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path("+repr(str(worker))+").write_text(str(os.getpid()));time.sleep(30);print('late-result')"
                    else:
                        code="print('重新开启后的可见活动')"
                    self.command=[sys.executable,'-c',code]
                    return self.run('probe')

                def summarize(self, path):
                    """记录停止后的新总结调用；该反例要求调用数保持零。"""
                    summaries.append(path)
                    return '测试总结'

            def wait_for(predicate):
                """有界等待真实状态，失败由driver负责通知主循环结束。"""
                deadline=time.monotonic()+4
                while not predicate():
                    if time.monotonic()>deadline:
                        raise AssertionError('集成运行未在期限内到达预期状态')
                    time.sleep(.005)

            def command(action):
                """通过正式本地socket发送一条命令，返回真实完成回执。"""
                request=ControlRequest(requestId=action,pid=os.getpid(),action=action)
                began=time.monotonic()
                with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
                    client.settimeout(1)
                    client.connect(str(home/'observer.sock'))
                    client.sendall((request.model_dump_json()+'\n').encode())
                    with client.makefile('rb') as stream:
                        reply=ControlReply.model_validate_json(stream.readline())
                durations[action]=round((time.monotonic()-began)*1000,2)
                self.assertTrue(reply.ok,reply.message)
                self.assertEqual(reply.pid,os.getpid())
                self.assertLess(durations[action],1000)
                return reply

            def driver():
                """控制真实主循环，失败时通过既有SIGTERM入口收尾。"""
                try:
                    wait_for(worker.exists)
                    if resume:
                        reply=command('disable-analysis')
                        self.assertFalse(reply.analysisEnabled)
                        before=len(list((home/'pictures').glob('????-??-??/*.jpg')))
                        wait_for(lambda: len(list((home/'pictures').glob('????-??-??/*.jpg')))>=before+2)
                        self.assertEqual(len(calls),1)
                        self.assertEqual(list((home/'records').glob('*.json')),[])
                        self.assertTrue(command('enable-analysis').analysisEnabled)
                        wait_for(lambda: bool(list((home/'records').glob('*.json'))))
                    self.assertEqual(command('stop').state,'stopped')
                except BaseException as error:
                    errors.append(error)
                    os.kill(os.getpid(),signal.SIGTERM)

            control_thread=threading.Thread(target=driver,daemon=True)
            output=io.StringIO()
            with patch.object(activity,'SensingCollector',collector), patch.object(activity,'KMHInterpreter',Model), \
                 patch.object(activity.permissions,'screen_capture_allowed',return_value=True), \
                 patch.object(runtime_logging,'LOG_PATH',home/'events.log'), redirect_stdout(output):
                control_thread.start()
                self.assertEqual(activity.run_activity(config=config),0)
                control_thread.join(2)
            self.assertFalse(control_thread.is_alive())
            if errors:
                raise errors[0]
            self.assertTrue(backend.closed)
            self.assertFalse((home/'observer.sock').exists())
            self.assertTrue(list((home/'pictures').glob('????-??-??/*.jpg')))
            self.assertTrue(all(model._process is None for model in models))
            pid=int(worker.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid,0)
            if resume:
                rows=json.loads(next((home/'records').glob('*.json')).read_text())
                self.assertEqual(rows[0]['analysis'],'重新开启后的可见活动')
                self.assertEqual(len(calls[1]),3)
                self.assertEqual(calls[1][0]['capturedAt'],calls[0][0]['capturedAt'])
            else:
                self.assertEqual(summaries,[])
                self.assertEqual(list((home/'records').glob('*.json')),[])
            print('CONTROL_METRICS '+json.dumps(durations))

    def test_disable_keeps_capture_and_reenable_catches_up_oldest(self):
        """取消顽固模型后截图持续，重开先处理最早积压；同进程完成全部操作。"""
        self.exercise(True)

    def test_stop_cancels_model_and_skips_due_summary_within_one_second(self):
        """分析中停止1秒内实际收口，旧结果取消，停止后零次新总结。"""
        self.exercise(False)

    def test_failed_cancel_can_retry_without_losing_task_owner(self):
        """首次回收报错后重复关闭仍调用原任务所有者，第二次成功才确认。"""
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=root/'tmp') as folder:
            home=Path(folder)
            attempts=[]
            class Model:
                def cancel(self,timeout=None):
                    attempts.append(timeout)
                    if len(attempts)==1:
                        raise RuntimeError('测试首次回收失败')
            control=RuntimeControl(home,True,load_config().control,lambda:None)
            control.interpreter=Model()
            request=ControlRequest(requestId='retry',pid=os.getpid(),action='disable-analysis')
            with patch.object(runtime_logging,'LOG_PATH',home/'events.log'),redirect_stdout(io.StringIO()):
                self.assertFalse(control.execute(request).ok)
                self.assertTrue(control.execute(request).ok)
            self.assertEqual(len(attempts),2)

    def test_disable_waits_for_short_commit_and_rejects_old_generation(self):
        """文件提交段先完整结束，再确认关闭；旧代次后续提交被取消。"""
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=root/'tmp') as folder:
            home=Path(folder)
            control=RuntimeControl(home,True,load_config().control,lambda:None)
            result=[]
            entered=threading.Event()
            def disable():
                entered.set()
                result.append(control.execute(ControlRequest(requestId='commit',pid=os.getpid(),action='disable-analysis')))
            with patch.object(runtime_logging,'LOG_PATH',home/'events.log'),redirect_stdout(io.StringIO()):
                with control.commit(0):
                    worker=threading.Thread(target=disable)
                    worker.start()
                    self.assertTrue(entered.wait(1))
                    time.sleep(.03)
                    self.assertEqual(result,[])
                worker.join(1)
            self.assertEqual(len(result),1)
            self.assertTrue(result[0].ok)
            with self.assertRaises(AnalysisCancelled):
                with control.commit(0):
                    self.fail('旧分析段应在提交前结束')

    def test_new_segment_keeps_previous_owner_when_cleanup_fails(self):
        """新段登记前必须收口旧任务，失败时原句柄继续由控制器持有。"""
        class Model:
            def cancel(self,timeout=None):
                raise RuntimeError('测试旧任务回收失败')
        control=RuntimeControl(Path('.'),True,load_config().control,lambda:None)
        previous=Model()
        control.interpreter=previous
        with self.assertRaisesRegex(RuntimeError,'回收失败'):
            control.set_interpreter(object(),0)
        self.assertIs(control.interpreter,previous)


if __name__=='__main__':
    unittest.main()
