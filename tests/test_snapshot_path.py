"""截图目录专项：真实配置、保存、选图和记录，桌面/模型只在边界替换。"""
from datetime import timedelta
from pathlib import Path
import json
import sys
import tempfile
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

    def test_s01_default_relative_absolute_and_activity_cli_override(self):
        """默认路径精确到snapshot-v1；相对/绝对和正式CLI覆盖独立于home。"""
        self.assertEqual(load_config().screenshotDir, self.project / 'data/snapshot-v1')
        config = load_config(self.path)
        self.assertEqual(config.screenshotDir, self.snapshots)
        self.assertEqual(config.with_overrides(home=self.root / 'other-home').screenshotDir, self.snapshots)
        before = self.path.read_bytes()
        with patch.object(activity, 'run_activity', return_value=0) as call:
            self.assertEqual(activity.main(['--config', str(self.path), '--screenshot-dir', str(self.root/'override')]), 0)
            self.assertEqual(call.call_args.kwargs['config'].screenshotDir, self.root/'override')
        self.assertEqual(self.path.read_bytes(), before)
        self.values['screenshotDir'] = str(self.root/'absolute')
        self.write()
        self.assertEqual(load_config(self.path).screenshotDir, self.root/'absolute')

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
