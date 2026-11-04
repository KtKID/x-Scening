"""YAML 配置专项；使用项目 tmp 独占目录，保留真实解析、图片和选图实现。"""
from copy import deepcopy
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import observe_activity as activity
from scening import permissions as screen
from scening import runtime_logging as images
from scening.observer_config import DEFAULT_CONFIG_PATH, load_config
from scening.collector import SensingCollector
from scening.capture import InputEvent
from test_scening import Backend, Clock, AT
from datetime import timedelta


class YamlConfigTests(unittest.TestCase):
    """以原配置生成输入，仅替换有明确预期的字段验证实际边界。"""

    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        (root / 'tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='yaml-config-', dir=root / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'observer.yaml'
        self.values = load_config().model_dump(mode='json')
        self.values['home'] = './data'
        self.values['screenshotDir'] = './pictures'
        self.values['kmhLauncher'] = './launcher.mjs'
        self.write()
        logger = patch.object(images, 'LOG_PATH', self.root / 'events.log')
        logger.start()
        self.addCleanup(logger.stop)

    def write(self, values=None):
        self.path.write_text('# 中文配置测试\n' + yaml.safe_dump(
            self.values if values is None else values, allow_unicode=True, sort_keys=False), encoding='utf-8')

    def collector(self):
        self.clock = Clock()
        collector = SensingCollector(load_config(self.path), backend=Backend(),
                                     clock=self.clock, wall_clock=self.clock.wall)
        self.addCleanup(collector.close)
        return collector

    def tick(self, collector, at):
        self.clock.value = at
        collector.tick(at)

    def event(self, collector, kind, at):
        collector.submit_event(InputEvent(kind, 250, 10, at))
        self.tick(collector, at)

    def test_y01_yaml_values_comments_and_relative_paths(self):
        """中文YAML直接加载，路径、根值和嵌套值使用所选文件。"""
        self.values.update(sampleIntervalSeconds=7.5, summaryIntervalSeconds=900)
        self.values['scening'].update(captureFps=4.0, jpegQuality=83)
        self.write()
        settings = load_config(self.path)
        self.assertEqual(settings.home, self.root / 'data')
        self.assertEqual(settings.kmhLauncher, self.root / 'launcher.mjs')
        self.assertEqual((settings.sampleIntervalSeconds, settings.summaryIntervalSeconds), (7.5, 900))
        self.assertEqual((settings.scening.captureFps, settings.scening.jpegQuality), (4, 83))
        self.assertEqual(DEFAULT_CONFIG_PATH.name, 'observer.yaml')
        self.assertFalse(DEFAULT_CONFIG_PATH.with_suffix('.json').exists())

    def test_y02_unsafe_broken_duplicate_and_invalid_values_preserve_input(self):
        """格式、重复键及类型错误在边界拒绝，原配置和数据目录保持。"""
        base = self.path.read_text(encoding='utf-8')
        cases = [('', ''), ('[]', ''), ('hello', ''), ('home: [broken', ''),
                 ('!!python/object/apply:os.system [echo unsafe]', ''),
                 (base + '\nsampleIntervalSeconds: 8\n', 'sampleIntervalSeconds'),
                 (base + '\nscening:\n  jpegQuality: 40\n', 'scening'),
                 (base.replace('  jpegQuality:', '  jpegQuality: 80\n  jpegQuality:'), 'jpegQuality')]
        for key, value in [('sampleIntervalSeconds', 0), ('captureCount', True),
                           ('modelTimeoutSeconds', float('inf')), ('differenceThreshold', float('nan')),
                           ('unknownValue', 10)]:
            invalid = deepcopy(self.values)
            invalid[key] = value
            cases.append((yaml.safe_dump(invalid), key))
        missing = deepcopy(self.values)
        del missing['screenshotDir']
        cases.append((yaml.safe_dump(missing), 'screenshotDir'))
        for content, field in cases:
            with self.subTest(content=content[:70], field=field):
                self.path.write_text(content, encoding='utf-8')
                before = self.path.read_bytes()
                with self.assertRaises(ValueError) as raised:
                    load_config(self.path)
                self.assertIn(str(self.path), str(raised.exception))
                self.assertIn(field, str(raised.exception))
                self.assertEqual(self.path.read_bytes(), before)
                self.assertFalse((self.root / 'data').exists())

    def test_y03_activity_cli_rejects_before_capture_or_model(self):
        """正式入口读取损坏 YAML 后退出2，采集与模型保持零调用。"""
        self.path.write_text('home: [broken', encoding='utf-8')
        with patch.object(activity, 'SensingCollector') as source, patch.object(activity, 'KMHInterpreter') as model:
            self.assertEqual(activity.main(['--config', str(self.path)]), 2)
        source.assert_not_called()
        model.assert_not_called()

    def test_y04_explicit_old_json_uses_yaml_scening_defaults(self):
        """显式旧JSON可读取，旧说明保持兼容，缺块从唯一YAML补齐。"""
        values = deepcopy(self.values)
        del values['scening']
        values['_comments'] = {'home': '保存目录'}
        legacy = self.root / 'old.json'
        legacy.write_text(json.dumps(values), encoding='utf-8')
        before = legacy.read_bytes()
        settings = load_config(legacy)
        self.assertEqual(settings.scening, load_config().scening)
        self.assertEqual(settings.home, self.root / 'data')
        self.assertNotIn('comments', settings.model_dump())
        self.assertEqual(legacy.read_bytes(), before)
        legacy.write_text('{"home":"./first","home":"./second"}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'home'):
            load_config(legacy)

    def test_y05_restart_snapshot_and_cli_precedence(self):
        """运行快照保持原值，重启读取新值，临时覆盖保留YAML文件。"""
        initial = load_config(self.path)
        self.values['scening']['keyboardIdleSeconds'] = 3.5
        self.write()
        before = self.path.read_bytes()
        changed = load_config(self.path, sampleIntervalSeconds=9)
        self.assertEqual(initial.scening.keyboardIdleSeconds, 2)
        self.assertEqual(changed.scening.keyboardIdleSeconds, 3.5)
        self.assertEqual(changed.sampleIntervalSeconds, 9)
        self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaises(ValueError):
            initial.scening.keyboardIdleSeconds = 4

    def test_y06_yaml_scroll_after_delay_changes_real_collector(self):
        """滚轮等待1.25秒时到期前保持输入段，到期后选出该时刻的真实JPEG。"""
        self.values['home'] = str(self.root / 'collector')
        self.values['scening'].update(scrollAfterSeconds=1.25, actionIntervalSeconds=2.0, minRawEvents=1)
        self.write()
        collector = self.collector()
        self.tick(collector, 0)
        collector.next_candidate(timeout=0)
        self.event(collector, 'scroll', .1)
        self.tick(collector, 1.34)
        self.assertIsNotNone(collector._scroll)
        self.tick(collector, 1.36)
        self.assertIsNone(collector._scroll)
        self.tick(collector, 2)
        selected = collector.next_candidate(timeout=0)
        self.assertEqual(selected.reason, 'action')
        self.assertEqual(selected.saved.at, AT + timedelta(seconds=1.36))
        self.assertTrue(selected.saved.path.is_file())

    def test_y07_yaml_missing_score_reaches_real_segmentation(self):
        """连续两轮整理中上一轮图已清理，缺图衔接分数使用YAML设定的321。"""
        self.values['home'] = str(self.root / 'collector')
        self.values['scening'].update(missingImageDifference=321.0, minRawEvents=1)
        self.write()
        collector = self.collector()
        self.tick(collector, 0)
        collector.next_candidate(timeout=0)
        for begin in (.1, 20.1):
            self.event(collector, 'click', begin)
            self.tick(collector, begin + 2.1)
            self.tick(collector, begin + 19.9)
            self.assertEqual(collector.next_candidate(timeout=0).reason, 'action')
        logs = collector.drain_status()
        segmented = [log for log in logs if log['result'] == 'segmented']
        self.assertEqual(segmented[-1]['diffScores'], [321.0])

    def test_y08_new_numeric_fields_are_strict_and_finite(self):
        """新增滚轮等待和缺图分数拒绝负值、布尔及非有限数，零秒等待有效。"""
        for key, value in [('scrollAfterSeconds', -1), ('scrollAfterSeconds', True),
                           ('scrollAfterSeconds', float('nan')), ('missingImageDifference', 0),
                           ('missingImageDifference', True), ('missingImageDifference', float('inf'))]:
            with self.subTest(key=key, value=value):
                values = deepcopy(self.values)
                values['scening'][key] = value
                self.write(values)
                with self.assertRaisesRegex(ValueError, key):
                    load_config(self.path)
        self.values['scening']['scrollAfterSeconds'] = 0
        self.write()
        self.assertEqual(load_config(self.path).scening.scrollAfterSeconds, 0)


if __name__ == '__main__':
    unittest.main()
