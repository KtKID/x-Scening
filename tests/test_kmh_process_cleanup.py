"""KMH任务资源回收契约；真实子进程及进程组，模型由本地等待程序替代。"""
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening.kmh_interpreter import KMHInterpreter
from scening.observer_config import load_config


@unittest.skipUnless(os.name == 'posix', '进程组回收契约适用于当前macOS采集端')
class KMHProcessCleanupTests(unittest.TestCase):
    """每例独占项目tmp；finally强制回收本例创建的进程，保留失败断言。"""

    def setUp(self):
        """建立独占home；子进程就绪时间和退出宽限采用局部验证配置。"""
        root = Path(__file__).resolve().parents[1]
        temporary = tempfile.TemporaryDirectory(prefix='kmh-cleanup-', dir=root / 'tmp')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.settings = load_config().with_overrides(
            home=self.home, modelTimeoutSeconds=.5, terminationGraceSeconds=.1)

    @staticmethod
    def alive(pid):
        """查询本例记录的进程身份是否仍存在，查询失败直接传播。"""
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def wait_gone(self, pid):
        """为系统回收已终止子进程保留少量时间，返回最终进程存在状态。"""
        deadline = time.monotonic() + .5
        while self.alive(pid) and time.monotonic() < deadline:
            time.sleep(.01)
        return not self.alive(pid)

    def run_tree(self, action, stubborn):
        """运行真实解释器与两层进程，返回解释器结束时子进程是否已消失。

        action为timeout或failure；stubborn决定工作进程是否忽略SIGTERM。
        启动器与工作进程保持同一进程组，工作进程关闭输出管道，覆盖组长先退出情形。
        退出时先保存观察结果，再在finally回收测试进程；调用异常按预期检查。
        """
        worker = self.home / 'worker.py'
        worker.write_text(
            "import os,pathlib,signal,sys,time\n"
            + ("signal.signal(signal.SIGTERM,signal.SIG_IGN)\n" if stubborn else '')
            + "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
            + "time.sleep(30)\n")
        launcher = self.home / 'launcher.py'
        launcher.write_text(
            "import os,pathlib,subprocess,sys,time\n"
            "home=pathlib.Path(sys.argv[1])\n"
            "(home/'launcher.pid').write_text(str(os.getpid()))\n"
            "subprocess.Popen([sys.executable,str(home/'worker.py'),str(home/'worker.pid')],"
            "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
            "deadline=time.monotonic()+3\n"
            "while not (home/'worker.pid').exists():\n"
            " if time.monotonic()>deadline: raise SystemExit(99)\n"
            " time.sleep(.005)\n"
            + ("raise SystemExit(7)\n" if action == 'failure' else "time.sleep(30)\n"))
        interpreter = KMHInterpreter(
            self.home, config=self.settings,
            command=[sys.executable, str(launcher), str(self.home)])
        try:
            expected = '退出码7' if action == 'failure' else '超时'
            with self.assertRaisesRegex(RuntimeError, expected):
                interpreter.run('资源回收测试')
            worker_pid = int((self.home / 'worker.pid').read_text())
            return self.wait_gone(worker_pid)
        finally:
            # 断言为红灯时也只清理本例登记的进程组及工作进程。
            leader = self.home / 'launcher.pid'
            worker_pid_path = self.home / 'worker.pid'
            worker_alive = worker_pid_path.exists() and self.alive(int(worker_pid_path.read_text()))
            if leader.exists() and (self.alive(int(leader.read_text())) or worker_alive):
                try:
                    os.killpg(int(leader.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if worker_pid_path.exists():
                worker_pid = int(worker_pid_path.read_text())
                try:
                    os.kill(worker_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.assertTrue(self.wait_gone(worker_pid), '测试清理应回收本例工作进程')

    def test_timeout_reaps_cooperative_process_group(self):
        """KMH调用超时后，普通启动器和同组工作进程都应结束。"""
        self.assertTrue(self.run_tree('timeout', stubborn=False))

    def test_timeout_reaps_stubborn_worker_after_launcher_exits(self):
        """启动器先响应TERM退出时，忽略TERM的工作进程仍应被强制回收。"""
        self.assertTrue(
            self.run_tree('timeout', stubborn=True),
            '启动器退出后，同组忽略SIGTERM的工作进程应完成回收')

    def test_launcher_failure_reaps_remaining_worker(self):
        """启动器失败退出后，该任务持有的工作进程也应结束。"""
        self.assertTrue(
            self.run_tree('failure', stubborn=True),
            'KMH失败返回后，该任务遗留工作进程应完成回收')

    def test_polling_preserves_full_stdout_and_one_total_deadline(self):
        """多次等待保留完整分段输出，超时仍由同一轮总预算约束。"""
        code="import time;print('首段',flush=True);time.sleep(.05);print('尾段',flush=True)"
        model=KMHInterpreter(self.home,config=self.settings,command=[sys.executable,'-c',code])
        self.assertEqual(model.run('分段输出'),'首段\n尾段')
        self.assertIsNone(model._process)
        model=KMHInterpreter(self.home,config=self.settings,
                             command=[sys.executable,'-c',"import time;time.sleep(30)"])
        start=time.monotonic()
        with self.assertRaisesRegex(RuntimeError,'超时'):
            model.run('单轮截止时间')
        self.assertLess(time.monotonic()-start,1.5)


if __name__ == '__main__':
    unittest.main()
