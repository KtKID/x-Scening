"""任务整理信号取消：真实CLI、KMH子进程、日锁与任务文件。"""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening.observer_config import load_config
from scening.task_store import read_activities
from scening.task_timeline import organize_day


@unittest.skipUnless(os.name == 'posix', '验证当前macOS的信号与文件锁')
class TaskSignalCancellationTests(unittest.TestCase):
    """模型边界为本地等待程序，其余入口、回收、日锁和保存均为真实执行。"""

    def setUp(self):
        """建立独占home及已成功保存的任务，再增加一条待关联活动。"""
        self.root = Path(__file__).resolve().parents[1]
        temporary = tempfile.TemporaryDirectory(prefix='task-signals-', dir=self.root / 'tmp')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.day = '2026-10-30'
        config = load_config().with_overrides(home=self.home)
        self.config = config
        self.config_path = self.home / 'observer.yaml'
        self.config_path.write_text(yaml.safe_dump(config.model_dump(mode='json'), allow_unicode=True))
        (self.home / 'records').mkdir()
        self.records_path = self.home / 'records' / f'{self.day}.json'
        rows = [dict(start=f'{self.day}T09:00:00+08:00', end=f'{self.day}T09:01:00+08:00',
                     app='Editor', analysis='排查登录问题', screenshot='a.jpg', mini='a.jpg')]
        self.records_path.write_text(json.dumps(rows, ensure_ascii=False))
        self.organize_without_model()
        self.tasks_path = self.home / 'task-timeline' / f'{self.day}.json'
        self.old_tasks = self.tasks_path.read_bytes()
        rows.append({**rows[0], 'start':f'{self.day}T10:00:00+08:00',
                     'end':f'{self.day}T10:01:00+08:00', 'analysis':'查看登录验证结果'})
        self.records_path.write_text(json.dumps(rows, ensure_ascii=False))
        self.old_records = self.records_path.read_bytes()

    def organize_without_model(self):
        """受控建议将所有待关联记录明确留为待关联，真实入口完成原子提交。"""
        rows, _ = read_activities(self.home, self.day)
        reply = json.dumps(dict(tasks=[], assignments=[dict(activityId=r['id'], taskKey=None)
                                                       for r in rows], progress=[]))
        class Model:
            def run(self, *args, **kwargs):
                return reply
        return organize_day(self.config, self.day, interpreter=Model())

    def exercise(self, phase):
        """在启动锁内、回收锁内或等待输出时发送停止信号，断言有界退出和锁释放。

        phase选择确定性触发点；finally只回收本例创建的Python与KMH进程组。
        成功后保持原正式形状文件逐字节相同，并用下一轮提交验证日锁可复用。
        """
        worker = self.home / 'worker.py'
        worker.write_text("import os,pathlib,signal,sys,time\n"
                          "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                          "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                          "time.sleep(30)\n")
        bootstrap = '''
import os,pathlib,signal,sys
from scening import task_timeline as api
from scening import kmh_interpreter as kmh
from scening import runtime_logging
home=pathlib.Path(sys.argv.pop(1));phase=sys.argv.pop(1)
runtime_logging.LOG_PATH=home/'events.log'
original=kmh.subprocess.Popen
def popen(*args,**kwargs):
    child=original(*args,**kwargs)
    (home/'child.pid').write_text(str(child.pid))
    if phase=='startup':os.kill(os.getpid(),signal.SIGTERM)
    return child
kmh.subprocess.Popen=popen
base=api.KMHInterpreter
class Interpreter(base):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.command=[sys.executable,str(home/'worker.py'),str(home/'ready.pid')]
    def _group_exists(self,pid):
        if phase=='cleanup' and not (home/'signal.sent').exists():
            (home/'signal.sent').write_text('ready')
            os.kill(os.getpid(),signal.SIGTERM)
        return super()._group_exists(pid)
api.KMHInterpreter=Interpreter
api.main()
'''
        # 回收阶段使用快速成功进程，信号精确落在_cleanup持锁期间。
        if phase == 'cleanup':
            worker.write_text("print('invalid proposal ignored after cancellation')\n")
        if phase == 'invalid':
            worker.write_text("print('private-failure-token')\n")
        env = {**os.environ, 'PYTHONPATH':str(self.root / 'src')}
        child = subprocess.Popen([sys.executable, '-B', '-c', bootstrap, str(self.home), phase,
                                  'organize', '--config', str(self.config_path), '--day', self.day],
                                 cwd=self.root, env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, start_new_session=True)
        try:
            if phase == 'waiting':
                deadline = time.monotonic() + 3
                while not (self.home / 'ready.pid').exists():
                    self.assertIsNone(child.poll(), 'CLI应先进入模型等待阶段')
                    self.assertLess(time.monotonic(), deadline, '模型应及时就绪')
                    time.sleep(.005)
                for _ in range(4):
                    if child.poll() is not None:
                        break
                    child.send_signal(signal.SIGTERM)
                    time.sleep(.01)
            try:
                out, err = child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                self.fail(f'{phase}阶段停止后CLI卡住，日锁仍被占用')
            self.assertEqual(child.returncode, 0, err.decode())
            reply = json.loads(out)
            self.assertEqual(reply['organizing'], 'failed')
            if phase == 'invalid':
                self.assertIn('TASK_ORGANIZER_INVALID_RESULT', ''.join(reply['issues']))
                logged=(self.home/'events.log').read_text()
                self.assertEqual(json.loads(logged.splitlines()[-1])['errorType'],'ValidationError')
                self.assertNotIn('private-failure-token',out.decode()+err.decode()+logged)
            else:
                self.assertIn('取消', ''.join(reply['issues']))
            self.assertEqual(self.tasks_path.read_bytes(), self.old_tasks)
            self.assertEqual(self.records_path.read_bytes(), self.old_records)
            with (self.home / 'task-timeline' / '.organize.lock').open('r') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            pid = int((self.home / 'child.pid').read_text())
            with self.assertRaises(ProcessLookupError):
                os.killpg(pid, 0)
            self.organize_without_model()
            self.assertNotEqual(self.tasks_path.read_bytes(), self.old_tasks)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=3)
            path = self.home / 'child.pid'
            if path.exists():
                try:
                    os.killpg(int(path.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_signal_during_startup_releases_task_lock(self):
        self.exercise('startup')

    def test_signal_during_cleanup_releases_task_lock(self):
        self.exercise('cleanup')

    def test_repeated_signals_while_waiting_cancel_once(self):
        self.exercise('waiting')

    def test_invalid_result_has_safe_diagnostic_without_model_text(self):
        self.exercise('invalid')


if __name__ == '__main__':
    unittest.main()
