"""桌面控制夹具：替换取屏/模型，保留真实Python进程、home锁和运行时控制通道。"""
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import time
import threading
from scening.observer_config import load_config
from scening.runtime_control import RuntimeControl
from scening import runtime_logging

# 沿用真实启动配置的位置解析，支持保存新home后重启的控制验证。
config_path = (Path(sys.argv[sys.argv.index('--config') + 1])
               if '--config' in sys.argv else Path.cwd() / 'observer.yaml')
settings = load_config(config_path)
home = settings.home
home.mkdir(exist_ok=True)
runtime_logging.LOG_PATH = home / 'events.log'
lock = (home / 'observer.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
stop = False


def done(*args):
    """通知本例生产循环结束，资源收尾仍通过真实控制器完成。"""
    global stop
    stop = True


signal.signal(signal.SIGTERM, done)


class Model:
    """延时文件用于观察切换中的停止优先级；默认立即完成取消。"""
    def __init__(self):
        self.pending = 0
        self.lock = threading.Lock()

    def cancel(self, timeout=None):
        delay = home / 'control-delay'
        if delay.exists():
            with self.lock:
                self.pending += 1
            try:
                time.sleep(float(delay.read_text()))
            finally:
                with self.lock:
                    self.pending -= 1


model = Model()
with RuntimeControl(home, '--capture-only' not in sys.argv, settings.control, done) as control:
    control.interpreter = model
    (home / 'launch-args.json').write_text(json.dumps(sys.argv))
    with (home / 'launched-pids').open('a') as stream:
        stream.write(str(os.getpid()) + '\n')
    print('ready', flush=True)
    while not stop:
        time.sleep(.01)
    while model.pending:
        time.sleep(.005)
    # delayed-stop
    with (home / 'finished-pids').open('a') as stream:
        stream.write(str(os.getpid()) + '\n')
