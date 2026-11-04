"""应用归属修复：系统采集是卡片与总结的应用来源，模型标签保留作原始结果。"""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import runtime_logging
from scening import app_identity
from scening.capture import Display, Frame
from scening.frame_store import Candidate, FrameStore
from scening.observe_activity import ActivityPipeline
from scening.observation_generated import ObservationResult
from scening.observer_config import load_config

AT = datetime(2026, 10, 29, 10, tzinfo=timezone(timedelta(hours=8)))


class Model:
    """模型故意填写错误软件标签；其他观察正文保持合法。"""
    def __init__(self):
        self.snapshot = None

    def analyze(self, path, frames=None):
        return ObservationResult(schema_version=1, visible_activity='核对合成界面。',
                                 inferred_intent='推测在验证采集。', stage_and_evidence='待确认。',
                                 app_tags=['Wrong Model App'])

    def summarize(self, path):
        self.snapshot = json.loads(path.read_text())
        return '依据系统采集应用生成的合成总结。'


class ApplicationFlowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='app-identity-unit-', dir=Path(__file__).resolve().parents[1] / 'tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = load_config().with_overrides(home=self.root / 'home', screenshotDir=self.root / 'pictures')
        logging = patch.object(runtime_logging, 'LOG_PATH', self.root / 'events.log')
        logging.start()
        self.addCleanup(logging.stop)
        self.model = Model()
        self.pipeline = ActivityPipeline(self.config.home, self.model, self.config)

    def batch(self, apps):
        """使用真实图片与JSON，输入逐帧系统应用信息，返回提交的活动。"""
        with closing(FrameStore(self.config.screenshotDir, self.config.scening.jpegQuality)) as store:
            for index, (app, bundle) in enumerate(apps):
                at = AT + timedelta(seconds=index * 20)
                with Image.new('RGB', (200, 100), ['red', 'green', 'blue'][index]) as image:
                    saved = store.save(Frame(image, at, Display(index % 2 + 1, 0, 0, 200, 100), app, bundle), 'test', temporary=False)
                self.pipeline.process(Candidate(saved, 'test').prepared, at, app, bundle, screen=index % 2 + 1)
        return json.loads((self.config.home / 'records/2026-10-29.json').read_text())[0]

    def test_mixed_batch_uses_ordered_system_apps_and_preserves_model_result(self):
        row = self.batch([('Editor', 'editor'), ('Browser', 'browser'), ('Editor', 'editor')])
        self.assertEqual(row['app'], 'Editor、Browser')
        self.assertIsNone(row['bundleId'])
        self.assertEqual(row['observation']['app_tags'], ['Wrong Model App'])
        self.assertEqual([frame['app'] for frame in row['frames']], ['Editor', 'Browser', 'Editor'])

    def test_summary_projects_frame_apps_even_when_legacy_top_level_is_stale(self):
        row = self.batch([('Editor', 'editor'), ('Browser', 'browser'), ('Editor', 'editor')])
        target = self.config.home / 'records/2026-10-29.json'
        row['app'] = 'Stale Captured App'
        target.write_text(json.dumps([row]))
        self.pipeline.summarize(AT - timedelta(seconds=1), AT + timedelta(minutes=1))
        self.assertEqual(self.model.snapshot['timeline'][0]['app'], 'Editor、Browser')
        saved = json.loads((self.config.home / 'summaries/2026-10-29.json').read_text())[0]
        self.assertEqual(saved['timeline'][0]['app'], 'Editor、Browser')
        self.assertNotIn('Wrong Model App', json.dumps(self.model.snapshot))
        self.assertEqual(json.loads(target.read_text())[0]['app'], 'Stale Captured App')

    def test_unknown_frame_stays_unknown_with_model_app_present(self):
        row = self.batch([('Editor', 'editor'), (None, None), ('Editor', 'editor')])
        self.assertEqual(row['app'], 'Editor、未知应用')
        self.pipeline.summarize(AT - timedelta(seconds=1), AT + timedelta(minutes=1))
        self.assertEqual(self.model.snapshot['timeline'][0]['app'], 'Editor、未知应用')


class SystemApplicationTests(unittest.TestCase):
    def window(self, pid, bounds, **changes):
        return {'kCGWindowOwnerPID': pid, 'kCGWindowLayer': 0, 'kCGWindowAlpha': 1,
                'kCGWindowBounds': dict(zip(('X', 'Y', 'Width', 'Height'), bounds)), **changes}

    def test_global_application_follows_live_pid_on_every_read(self):
        with patch.object(app_identity, 'frontmost_pid', side_effect=[101, 202, 101]), patch.object(app_identity, 'application_for_pid', side_effect=lambda pid: {101: ('Editor', 'editor'), 202: ('Browser', 'browser')}[pid]):
            self.assertEqual([app_identity.frontmost_application() for _ in range(3)],
                             [('Editor', 'editor'), ('Browser', 'browser'), ('Editor', 'editor')])

    def test_two_displays_use_each_visible_window_and_handle_negative_coordinates(self):
        first = Display(1, 0, 0, 2560, 1440)
        second = Display(2, 0, -1440, 2560, 1440)
        windows = [self.window(999, (0, 0, 2560, 25), kCGWindowLayer=24),
                   self.window(101, (10, 25, 2400, 1300)),
                   self.window(202, (10, -1415, 2400, 1300)),
                   self.window(303, (10, -1415, 2400, 1300))]
        with patch('Quartz.CGWindowListCopyWindowInfo', return_value=windows), patch.object(app_identity, 'application_for_pid', side_effect=lambda pid: {101: ('Editor', 'editor'), 202: ('Browser', 'browser')}[pid]), patch.object(app_identity, 'frontmost_pid', return_value=101) as global_pid:
            self.assertEqual(app_identity.frontmost_application(first), ('Editor', 'editor'))
            self.assertEqual(app_identity.frontmost_application(second), ('Browser', 'browser'))
            global_pid.assert_not_called()

    def test_window_filter_handles_edges_spanning_transparency_and_invalid_rectangles(self):
        display = Display(1, 0, 0, 200, 100)
        windows = [self.window(1, (200, 0, 50, 50)), self.window(2, (-50, 0, 50, 50)),
                   self.window(3, (-50, -20, 100, 100)), self.window(3, (0, 0, 100, 100)),
                   self.window(4, (0, 0, 100, 100), kCGWindowAlpha=0),
                   self.window(5, (0, 0, 100, 100), kCGWindowLayer=3),
                   self.window(6, (0, 0, float('nan'), 100)), self.window(7, (0, 0, 0, 100)),
                   {'kCGWindowLayer': 0, 'kCGWindowOwnerPID': 8, 'kCGWindowBounds': {}}]
        self.assertEqual(app_identity.display_window_pids(windows, display), [3])

    def test_auxiliary_process_is_skipped_and_empty_or_failed_window_list_stays_unknown(self):
        display = Display(1, 0, 0, 200, 100)
        windows = [self.window(99, (0, 0, 20, 20)), self.window(101, (0, 0, 200, 100))]
        with patch('Quartz.CGWindowListCopyWindowInfo', return_value=windows), patch.object(app_identity, 'application_for_pid', side_effect=[(None, None), ('Editor', 'editor')]):
            self.assertEqual(app_identity.frontmost_application(display), ('Editor', 'editor'))
        with patch('Quartz.CGWindowListCopyWindowInfo', return_value=[]):
            self.assertEqual(app_identity.frontmost_application(display), (None, None))
        with patch('Quartz.CGWindowListCopyWindowInfo', return_value=None):
            with self.assertRaisesRegex(RuntimeError, '窗口列表'):
                app_identity.frontmost_application(display)


if __name__ == '__main__':
    unittest.main()
