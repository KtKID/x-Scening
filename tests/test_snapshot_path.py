"""截图目录专项：真实配置、保存、选图和记录，桌面/模型只在边界替换。"""
from datetime import datetime, timedelta
from pathlib import Path
import json
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import observe_activity as activity
from scening import permissions as screen
from scening import runtime_logging as images
from scening.activity_memory import ActivityEvent, ActivityMemory
from scening.capture import Frame, InputEvent
from scening.collector import SensingCollector
from scening.frame_store import Candidate, FrameStore
from scening.observer_config import load_config
from test_scening import Backend, Clock, AT


class SnapshotPathTests(unittest.TestCase):
    def setUp(self):
        self.project = Path(__file__).resolve().parents[1]
        (self.project / 'tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='snapshot-path-', dir=self.project / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'memory'
        self.snapshots = self.root / 'pictures'
        self.path = self.root / 'observer.yaml'
        self.values = load_config().model_dump(mode='json')
        self.values.update(home='./memory', screenshotDir='./pictures')
        self.write()
        logger = patch.object(images, 'LOG_PATH', self.root / 'events.log')
        logger.start()
        self.addCleanup(logger.stop)
        images.initialize_logging()

    def write(self):
        self.path.write_text(yaml.safe_dump(self.values, allow_unicode=True), encoding='utf-8')

    def test_live_switch_keeps_capture_analysis_and_log_destinations_consistent(self):
        """同一次采集中切换目录，实际 JPEG、索引、活动、总结和日志各自落盘。"""
        target = self.root / 'TMP' / 'new-pictures'
        log = images.LOG_PATH
        wall_start = datetime.now().astimezone()
        day = wall_start.date().isoformat()
        backend = Backend()
        observed = {}
        self.values['sampleIntervalSeconds'] = 1.05
        self.values['scening']['captureFps'] = 10
        self.values['scening']['observationIntervalSeconds'] = 1
        self.values['privacy']['enabled'] = False
        self.write()

        def wait_for_index(root, count):
            deadline = time.monotonic() + 5
            index = root / day / 'index.json'
            while time.monotonic() < deadline:
                if index.exists():
                    items = json.loads(index.read_text())['images']
                    if len(items) >= count:
                        return [root / item['file'] for item in items]
                time.sleep(.025)
            self.fail('等待正式截图索引超时：' + str(index))

        class Model:
            def analyze(model, image, frames=None):
                if not observed:
                    # 模型执行期间额外产生旧目录候选，稍后由同一消费者处理。
                    old_files = wait_for_index(self.snapshots, 4)
                    observed['old'] = {item: item.read_bytes() for image in old_files
                                       for item in (image, image.with_suffix('.jpg.metadata.json'))}
                    observed['log'] = log.read_bytes()
                    backend.colors[1] = 'green'
                    self.values['screenshotDir'] = './TMP/new-pictures'
                    self.values['home'] = './next-start-only'
                    updated = self.path.with_suffix('.tmp')
                    updated.write_text(yaml.safe_dump(self.values), encoding='utf-8')
                    updated.replace(self.path)
                    wait_for_index(target, 1)
                return '已分析测试截图。'

            def summarize(model, path):
                return '已总结测试活动。'

        def collector(config, **kwargs):
            return SensingCollector(config, backend=backend,
                                    app_provider=lambda *_: ('Editor', 'editor'))

        with patch.object(activity, 'SensingCollector', collector), \
             patch.object(activity, 'KMHInterpreter', return_value=Model()), \
             patch.object(screen, 'screen_capture_allowed', return_value=True):
            result = activity.main(['--config', str(self.path), '--count', '9',
                                    '--summary-on-exit'])
        self.assertEqual(result, 0)
        self.assertTrue(observed['old'])
        self.assertTrue(log.read_bytes().startswith(observed['log']))
        self.assertGreater(len(log.read_bytes()), len(observed['log']))
        events = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertFalse(any(event['result'] == 'metadata_failed'
                             or (event['stage'], event['result']) == ('capture_metadata', 'failed')
                             for event in events))
        self.assertFalse((self.root / 'next-start-only').exists())
        for image, content in observed['old'].items():
            self.assertEqual(image.read_bytes(), content)
        for root in (self.snapshots, target):
            index = json.loads((root / day / 'index.json').read_text())
            self.assertTrue(any(item['analyzed'] for item in index['images']))
            for item in index['images']:
                image = root / item['file']
                self.assertTrue(image.is_file())
                metadata = json.loads(image.with_suffix('.jpg.metadata.json').read_text())
                self.assertEqual(metadata['file'], item['file'])
        rows = json.loads((self.home / 'records' / f'{day}.json').read_text())
        self.assertEqual(len(rows), 2)
        for row, root in zip(rows, (self.snapshots, target)):
            self.assertTrue((self.home / row['screenshot']).is_relative_to(self.home / 'analysis'))
            self.assertTrue(all(Path(frame['screenshot']).is_relative_to(root) for frame in row['frames']))
        self.assertTrue((self.home / 'summaries' / f'{day}.json').is_file())
        self.assertFalse(list(target.rglob('*.log')))

    def test_s01_default_relative_absolute_and_activity_cli_override(self):
        """默认路径精确到snapshot-v1；相对/绝对和正式CLI覆盖独立于home。"""
        self.assertEqual(load_config().screenshotDir, self.project / 'data/snapshot-v1')
        config = load_config(self.path)
        self.assertEqual(config.screenshotDir, self.snapshots)
        self.assertEqual(config.with_overrides(home=self.root / 'other-home').screenshotDir, self.snapshots)
        before = self.path.read_bytes()
        with patch.object(activity, 'DEV_CONFIG_PATH', self.path), \
             patch('scening.observer_config.DEV_CONFIG_PATH', self.path), \
             patch.object(activity, 'run_activity', return_value=0) as call:
            self.assertEqual(activity.main(['--capture-only']), 0)
            self.assertEqual(call.call_args.kwargs['config_path'], self.path)
        with patch.object(activity, 'run_activity', return_value=0) as call:
            self.assertEqual(activity.main(['--config', str(self.path), '--screenshot-dir', str(self.root/'override')]), 0)
            self.assertEqual(call.call_args.kwargs['config'].screenshotDir, self.root/'override')
            self.assertIsNone(call.call_args.kwargs['config_path'])
        self.assertEqual(self.path.read_bytes(), before)
        self.values['screenshotDir'] = str(self.root/'absolute')
        self.write()
        self.assertEqual(load_config(self.path).screenshotDir, self.root/'absolute')

    def test_live_invalid_target_recovers_without_writing_to_old_directory(self):
        """目标是普通文件时本次不保存，修正路径后同一采集器继续发布。"""
        clock = Clock()
        self.values['privacy']['enabled'] = False
        self.write()
        collector = SensingCollector(load_config(self.path), backend=Backend(),
                                     clock=clock, wall_clock=clock.wall)
        self.addCleanup(collector.close)
        collector.watch_screenshot_directory(self.path)
        with Image.new('RGB', (10, 10), 'blue') as image:
            def publish(offset):
                frame = Frame(image, AT + timedelta(seconds=offset), Backend().screens[0])
                collector._publish(collector.store.stage(frame), 'periodic')

            publish(0)
            old = collector.next_candidate(timeout=0).saved.path.parent
            before = {item.name: item.read_bytes() for item in old.iterdir()}
            blocked = self.root / 'file'
            blocked.write_bytes(b'keep')
            self.values['screenshotDir'] = './file'
            self.write()
            with self.assertRaises(OSError):
                publish(1)
            self.assertIsNone(collector.next_candidate(timeout=0))
            self.assertEqual(blocked.read_bytes(), b'keep')
            self.path.write_text('screenshotDir: [', encoding='utf-8')
            with self.assertRaisesRegex(OSError, '截图保存目录读取失败'):
                publish(2)
            self.values['screenshotDir'] = './TMP/recovered'
            self.write()
            publish(3)
        new = collector.next_candidate(timeout=0).saved.path
        self.assertEqual(new.parent.parent, self.root / 'TMP/recovered')
        self.assertTrue((new.parent / 'index.json').is_file())
        self.assertEqual({item.name: item.read_bytes() for item in old.iterdir()}, before)

    def test_s02_real_collector_periodic_action_and_collision_use_exact_directory(self):
        """定时与真实选图JPEG位于独立目录的采集日期子目录，事件临时图清理，重名保留。"""
        clock = Clock()
        config = load_config(self.path)
        collector = SensingCollector(config, backend=Backend(), clock=clock, wall_clock=clock.wall)
        self.addCleanup(collector.close)
        collector.tick(0)
        first = collector.next_candidate(timeout=0)
        self.assertEqual(first.saved.path.parent, self.snapshots / first.saved.at.date().isoformat())
        before = first.saved.path.read_bytes()
        for at in (.1, .4):
            collector.submit_event(InputEvent('key', 250, 10, at))
            clock.value = at
            collector.tick(at)
        for at in (2.5, 20):
            clock.value = at
            collector.tick(at)
        action = collector.next_candidate(timeout=0)
        self.assertEqual(action.reason, 'action')
        self.assertEqual(action.saved.path.parent, self.snapshots / action.saved.at.date().isoformat())
        self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])
        saved = collector.store.save(Frame(Image.new('RGB', (10, 10)), AT, Backend().screens[0]), 'periodic', temporary=False)
        self.assertNotEqual(first.saved.path, saved.path)
        self.assertEqual(first.saved.path.read_bytes(), before)
        self.assertFalse((self.snapshots/'screenshot').exists())
        self.assertFalse((self.home/'screenshot').exists())


    def test_s04_external_images_append_extend_summary_and_switch_directory(self):
        """home外图片支持真实追加、延长和总结；切换目录后历史引用保留。"""
        class Model:
            def analyze(self, image, frames=None):
                return '可见事实：测试图片。'
            def summarize(self, path):
                return '可见事实：活动总结。'
        config = load_config(self.path)
        pipeline = activity.ActivityPipeline(self.home, interpreter=Model(), config=config)
        old = {'start':(AT-timedelta(seconds=2)).isoformat(),'end':(AT-timedelta(seconds=2)).isoformat(),
               'app':'Old','bundleId':'old','analysis':'历史活动','source':'screen',
               'screenshot':'screenshot/old.png','mini':'screenshot/old_mini.png'}
        pipeline.memory.append(old)
        store = FrameStore(self.snapshots, 70)
        self.addCleanup(store.close)
        with Image.new('RGB', (20, 10), 'red') as image:
            saved = store.save(Frame(image, AT, Backend().screens[0]), 'periodic', temporary=False)
        prepared = Candidate(saved, 'periodic').prepared
        for index in range(3):
            at=AT+timedelta(seconds=index)
            result=pipeline.process(prepared,at,'Editor','editor')
        self.assertEqual(result,'analyzed')
        for index in range(3,6):
            at=AT+timedelta(seconds=index)
            result=pipeline.process(prepared,at,'Editor','editor')
        self.assertEqual(result,'extended')
        rows = json.loads((self.home/'records/2026-10-27.json').read_text())
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], old)
        self.assertEqual(rows[1]['frames'][0]['screenshot'],str(saved.path))
        self.assertTrue((self.home/rows[1]['screenshot']).is_file())
        self.assertEqual(rows[1]['end'], (AT+timedelta(seconds=5)).isoformat(timespec='seconds'))
        pipeline.summarize(AT-timedelta(seconds=3), AT+timedelta(seconds=6))
        self.assertTrue((self.home/'summaries/2026-10-27.json').is_file())
        next_config = config.with_overrides(screenshotDir=self.root/'new-pictures')
        memory = ActivityMemory(self.home, screenshot_dir=next_config.screenshotDir)
        timeline, gaps = memory.window(AT-timedelta(seconds=3), AT+timedelta(seconds=6))
        self.assertEqual(len(timeline), 2)
        self.assertEqual(gaps, [])
        self.assertEqual(timeline[1]['frames'][0]['screenshot'], str(saved.path))
        next_store = FrameStore(next_config.screenshotDir, 70)
        self.addCleanup(next_store.close)
        with Image.new('RGB', (20, 10), 'blue') as image:
            next_saved = next_store.save(Frame(image, AT+timedelta(seconds=6), Backend().screens[0]), 'periodic', temporary=False)
        restarted = activity.ActivityPipeline(self.home, interpreter=Model(), config=next_config)
        for index in range(6,9):
            result=restarted.process(Candidate(next_saved,'periodic').prepared,AT+timedelta(seconds=index),'Editor','editor')
        self.assertEqual(result,'analyzed')
        restarted.summarize(AT-timedelta(seconds=3), AT+timedelta(seconds=9))
        self.assertEqual(len(json.loads((self.home/'records/2026-10-27.json').read_text())), 3)
        self.assertEqual(len(json.loads((self.home/'summaries/2026-10-27.json').read_text())), 2)

    def test_s05_legacy_empty_paths_and_invalid_references_preserve_files(self):
        """配置缺字段时报错；空路径、穿越和越界新引用拒绝。"""
        del self.values['screenshotDir']
        self.write()
        with self.assertRaisesRegex(ValueError, 'screenshotDir'):
            load_config(self.path)
        self.values['screenshotDir'] = ' '
        self.write()
        with self.assertRaisesRegex(ValueError, 'screenshotDir'):
            load_config(self.path)
        store = ActivityMemory(self.home, screenshot_dir=self.snapshots)
        row = {'start':AT.isoformat(),'end':AT.isoformat(),'analysis':'测试',
               'screenshot':'screenshot/old.png','mini':'screenshot/old_mini.png'}
        store.append(row)
        path = self.home/'records/2026-10-27.json'
        before = path.read_bytes()
        for value in ('../escape.png', str(self.root/'outside.png')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                store.append(dict(row, screenshot=value))
            self.assertEqual(path.read_bytes(), before)
        with self.assertRaises(ValueError):
            ActivityEvent.model_validate(dict(row, screenshot=str(self.snapshots/'image.jpg')))

    def test_s06_blocked_target_stops_capture_without_alternate_directory(self):
        """截图目录为已有文件时正式入口失败，原文件保留，业务分析调用为零。"""
        self.snapshots.write_bytes(b'existing')
        with patch.object(screen, 'screen_capture_allowed', return_value=True), \
             patch.object(activity, 'KMHInterpreter') as model:
            self.assertEqual(activity.main(['--config', str(self.path), '--capture-only', '--count', '1']), 1)
        model.assert_not_called()
        self.assertEqual(self.snapshots.read_bytes(), b'existing')
        self.assertFalse((self.home/'screenshot').exists())


if __name__ == '__main__':
    unittest.main()
