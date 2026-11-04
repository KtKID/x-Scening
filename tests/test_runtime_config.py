"""运行配置测试；保留真实配置、图片、JSON与子进程，隔离桌面和网络调用。"""
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
import re
import yaml
from pathlib import Path
import subprocess
import time
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import observe_activity as activity
from scening import permissions as screen
from scening import kmh_interpreter as kmh


from scening_fixtures import PreparedSource

class RuntimeConfigTests(unittest.TestCase):
    """用区别于默认值的配置验证实际消费者及错误边界。"""
    def setUp(self):
        source_patch = patch.object(activity, 'SensingCollector', PreparedSource)
        source_patch.start()
        self.addCleanup(source_patch.stop)
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / "tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.path = self.root / 'observer.yaml'
        self.values = {
            'home': './data', 'screenshotDir': './pictures', 'sampleIntervalSeconds': 3,
            'summaryIntervalSeconds': 6, 'captureCount': 4,
            'differenceThreshold': 0.1, 'captureTimeoutSeconds': 2.5,
            'modelTimeoutSeconds': 1, 'terminationGraceSeconds': 0.05,
            'analysisMaxChars': 77, 'summaryMaxChars': 66,
            'kmhLauncher': './launcher.mjs', 'kmhProfile': 'test_observer',
        }
        self.path.write_text(yaml.safe_dump(self.values))
        self.log = self.root / 'events.log'
        self.images = activity.runtime_logging
        self.log_patch = patch.object(self.images, 'LOG_PATH', self.log)
        self.log_patch.start()
        self.addCleanup(self.log_patch.stop)

    def config(self):
        """延迟读取实现模块，测试入口的行为变化可独立取得红灯。"""
        from scening.observer_config import load_config
        return load_config(self.path)

    def test_t1_schema_paths_overrides_and_invalid_values(self):
        """配置路径可定位、相对路径稳定、非法参数在输入边界拒绝。"""
        from scening.observer_config import load_config
        settings = self.config()
        self.assertEqual(settings.home, self.root / 'data')
        self.assertEqual(settings.kmhLauncher, self.root / 'launcher.mjs')
        self.assertEqual(settings.sampleIntervalSeconds, 3)
        before = self.path.read_bytes()
        changed = settings.with_overrides(sampleIntervalSeconds=9, home='./cli-home')
        self.assertEqual(changed.sampleIntervalSeconds, 9)
        self.assertEqual(changed.home, Path('cli-home').resolve())
        self.assertEqual(self.path.read_bytes(), before)
        for key, value in [('sampleIntervalSeconds', 0), ('summaryIntervalSeconds', -1),
                           ('captureTimeoutSeconds', float('nan')), ('modelTimeoutSeconds', float('inf')),
                           ('terminationGraceSeconds', 0), ('captureTimeoutSeconds', -1),
                           ('captureCount', -1), ('captureCount', True),
                           ('analysisMaxChars', 0), ('summaryMaxChars', '66'),
                           ('differenceThreshold', 1.01), ('extraField', 1)]:
            with self.subTest(key=key, value=value):
                self.path.write_text(yaml.safe_dump(dict(self.values, **{key: value})))
                with self.assertRaises(ValueError) as raised:
                    load_config(self.path)
                self.assertIn(key, str(raised.exception))
        missing = dict(self.values)
        del missing['screenshotDir']
        self.path.write_text(yaml.safe_dump(missing))
        with self.assertRaisesRegex(ValueError, 'screenshotDir'):
            load_config(self.path)
        self.path.write_text('{broken')
        with self.assertRaisesRegex(ValueError, 'observer.yaml'):
            load_config(self.path)
        with self.assertRaisesRegex(ValueError, 'missing.json'):
            load_config(self.root / 'missing.json')
        self.assertFalse((self.root / 'data').exists())

    def test_t2_activity_cli_uses_config_and_rejects_before_capture(self):
        """主入口把完整快照传到运行层；CLI优先且错误配置保持采集零次。"""
        with patch.object(activity, 'run_activity', return_value=0) as run:
            self.assertEqual(activity.main(['--config', str(self.path), '--interval', '9', '--count', '1']), 0)
        run.assert_called_once()
        settings = run.call_args.kwargs['config']
        self.assertEqual(settings.sampleIntervalSeconds, 9)
        self.assertEqual(settings.captureCount, 1)
        self.assertEqual(settings.summaryIntervalSeconds, 6)
        self.assertEqual(settings.home, self.root / 'data')
        with patch.object(activity, 'run_activity', return_value=0) as run:
            self.assertEqual(activity.main(['--config', str(self.path), '--summary-interval', '12', '--capture-timeout', '8', '--model-timeout', '7', '--difference-threshold', '.2']), 0)
        changed = run.call_args.kwargs['config']
        self.assertEqual((changed.summaryIntervalSeconds, changed.captureTimeoutSeconds, changed.modelTimeoutSeconds, changed.differenceThreshold), (12, 8, 7, .2))
        self.path.write_text(yaml.safe_dump(dict(self.values, sampleIntervalSeconds=0)))
        before = self.path.read_bytes()
        with patch.object(activity, 'SensingCollector') as capture, patch.object(activity, 'KMHInterpreter') as model:
            self.assertEqual(activity.main(['--config', str(self.path)]), 2)
        capture.assert_not_called()
        model.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertIn('sampleIntervalSeconds', self.log.read_text())

    def test_t3_actual_pipeline_uses_snapshot_for_timing_images_and_threshold(self):
        """可控时钟运行四轮，第三帧提交和六秒总结使用同一快照，末帧保留待凑。"""
        settings = self.config()
        start = datetime(2026, 10, 19, 12, tzinfo=timezone(timedelta(hours=8)))
        class Clock:
            now = 0
            waits = []
            def is_set(self):
                return False
            def wait(self, delay):
                self.waits.append(delay)
                self.now += delay
        clock = Clock()
        class DateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return start + timedelta(seconds=clock.now)
        model_calls, summary_inputs, starts = [], [], []
        colors = iter(['black', (12, 12, 12), 'white', 'white'])
        class Model:
            def analyze(self, mini, frames=None):
                model_calls.append(str(mini))
                return '可见事实：测试画面。'
            def summarize(self, path):
                summary_inputs.append(json.loads(path.read_text()))
                return '可见事实：测试活动。'
        def capture(at, config):
            starts.append(clock.now)
            if len(starts) == 2:
                self.path.write_text(yaml.safe_dump(dict(self.values, sampleIntervalSeconds=40)))
            return Image.new('RGB', (240, 120), next(colors))
        from types import SimpleNamespace
        original_control = activity.RuntimeControl
        class TimedControl(original_control):
            def __init__(self, *args):
                super().__init__(*args)
                self.changed = clock
        clock.clear = lambda: None
        with patch.object(activity, 'datetime', DateTime), patch.object(activity, 'time', SimpleNamespace(monotonic=lambda: clock.now)), patch.object(activity, 'RuntimeControl', TimedControl), patch.object(screen, 'screen_capture_allowed', return_value=True), patch.object(PreparedSource, 'frame_provider', side_effect=capture), patch.object(activity, 'frontmost_application', return_value=('Test', 'test.app')), patch.object(activity, 'KMHInterpreter', return_value=Model()) as factory:
            self.assertEqual(activity.run_activity(config=settings), 0)
        self.assertEqual(starts, [0, 3, 6, 9])
        self.assertEqual(clock.waits, [3, 3, 3])
        self.assertEqual(factory.call_args.kwargs['config'], settings)
        self.assertEqual(len(model_calls), 1)
        pictures = list(settings.screenshotDir.glob('????-??-??/*.jpg'))
        self.assertEqual(len(pictures), 4)
        for picture in pictures:
            with Image.open(picture) as image:
                self.assertEqual(image.size, (240, 120))
        records = json.loads((settings.home / 'records/2026-10-19.json').read_text())
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['end'], (start + timedelta(seconds=6)).isoformat())
        self.assertEqual(len(records[0]['frames']), 3)
        self.assertEqual(len(summary_inputs), 1)
        self.assertEqual(summary_inputs[0]['windowStart'], start.isoformat())
        self.assertEqual(summary_inputs[0]['windowEnd'], (start + timedelta(seconds=6)).isoformat())
        events = [json.loads(line) for line in self.log.read_text().splitlines()]
        effective = next(e['effectiveConfig'] for e in events if e['stage'] == 'activity_observer' and e['result'] == 'started')
        self.assertNotIn('miniMaxWidth', effective)
        self.assertEqual(effective['summaryIntervalSeconds'], 6)

    def test_t4_kmh_uses_launcher_profile_prompt_limits_and_termination_grace(self):
        """真实本机子进程检查调用配置、两类字数要求及超时后退出宽限。"""
        launcher = self.root / 'launcher.mjs'
        launcher.write_text('console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.KMH_HOME}));')
        settings = self.config()
        interpreter = kmh.KMHInterpreter(self.root / 'data', config=settings)
        result = json.loads(interpreter.analyze(self.root / 'sample.jpg'))
        self.assertEqual(result['args'][:3], ['dsh', '--profile', 'test_observer'])
        self.assertEqual(result['home'], str(self.root / 'data/kmh'))
        self.assertIn('不超过77字', result['args'][-1])
        summary = json.loads(interpreter.summarize(self.root / 'window.json'))
        self.assertIn('不超过66字', summary['args'][-1])
        calls, waits, processes = [], [], []
        real_popen = subprocess.Popen
        class TrackingPopen(real_popen):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                processes.append(self)
            def communicate(self, *args, **kwargs):
                calls.append(kwargs.get('timeout'))
                return super().communicate(*args, **kwargs)
            def wait(self, *args, **kwargs):
                waits.append(kwargs.get('timeout'))
                return super().wait(*args, **kwargs)
        command = [sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)']
        started = time.monotonic()
        with patch.object(kmh.subprocess, 'Popen', TrackingPopen):
            with self.assertRaisesRegex(RuntimeError, '超时'):
                kmh.KMHInterpreter(settings.home, timeout=.2, command=command, config=settings).run('测试')
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, .2)
        self.assertLess(elapsed, 1.3)
        self.assertTrue(all(0 < value <= settings.control.pollSeconds
                            for value in calls if value is not None))
        self.assertTrue(any(value is not None and 0 < value <= .05 for value in waits))
        self.assertIsNotNone(processes[0].poll())



    def test_t7_comments_cover_all_settings_and_keep_runtime_values(self):
        """默认YAML每个参数紧邻中文注释，注释及临时覆盖保持运行值。"""
        from scening.observer_config import DEFAULT_CONFIG_PATH, load_config
        content = DEFAULT_CONFIG_PATH.read_text(encoding='utf-8')
        defaults = yaml.safe_load(content)
        expected = set(defaults) | {block + '.' + key for block in ('scening', 'desktop', 'analysis', 'control', 'dailyReview', 'taskTimeline', 'privacy') for key in defaults[block]}
        notes = {}
        previous = ''
        block = ''
        for line in content.splitlines():
            matched = re.match(r'^( *)([A-Za-z][A-Za-z0-9]*):', line)
            if matched:
                if not matched[1]:
                    block = matched[2]
                key = (block + '.' if matched[1] else '') + matched[2]
                self.assertTrue(previous.strip().startswith('#'), key)
                self.assertTrue(any('\u4e00' <= char <= '\u9fff' for char in previous), key)
                notes[key] = previous
            previous = line
        self.assertEqual(set(notes), expected)
        self.assertNotIn('_comments', defaults)
        plain = self.config()
        self.path.write_text('# 只有中文注释变化\n' + self.path.read_text(), encoding='utf-8')
        annotated = load_config(self.path)
        self.assertEqual(annotated.model_dump(), plain.model_dump())
        changed = annotated.with_overrides(sampleIntervalSeconds=9)
        self.assertEqual(changed.sampleIntervalSeconds, 9)
        self.assertNotIn('_comments', changed.model_dump(mode='json'))
        self.assertNotIn('comments', changed.model_dump(mode='json'))
        self.path.write_text(yaml.safe_dump(dict(self.values, _comments={'home': 123})))
        with self.assertRaises(ValueError):
            load_config(self.path)


if __name__ == '__main__':
    unittest.main()
