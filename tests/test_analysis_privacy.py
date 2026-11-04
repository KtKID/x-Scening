"""积压隐私回归：两个真实入口复用现有闸门，文件、索引、拼图和报告实际执行。"""
from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import Image
from scening.capture import Display, Frame
from scening.capture_metadata import metadata_path, save_capture
from scening.frame_store import Candidate, FrameStore
from scening.observer_config import load_config
from scening.observe_activity import ActivityPipeline
from scening.runtime_control import AnalysisCancelled
from scening.screenshot_backfill import backfill_day
from scening.screenshot_index import rebuild_day
from scening.screenshot_queue import ScreenshotQueue


class Model:
    """记录实际提交的逐帧证据，模型返回固定合成正文。"""
    def __init__(self):
        self.calls = []

    def analyze(self, image, frames=None):
        self.calls.append(frames)
        return '合成活动：查看本地文档'


class AnalysisPrivacyTests(unittest.TestCase):
    """仅替换OCR文本边界，两种入口实际调用SensitiveGuard及现有检测规则。"""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='analysis-privacy-', dir='tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.at = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        self.day = self.at.date().isoformat()
        logging = patch('scening.observe_activity.log_event')
        self.logs = logging.start()
        self.addCleanup(logging.stop)

    def setup_case(self, mode, *, count=3, app='Notes', bundle='com.apple.Notes', metadata=True):
        """按入口独占home、JPEG与采集旁文件，返回实际队列和模型。"""
        config = load_config().with_overrides(home=self.root/mode/'home', screenshotDir=self.root/mode/'shots')
        store = FrameStore(config.screenshotDir, config.scening.jpegQuality)
        self.addCleanup(store.close)
        paths = []
        for number in range(count):
            with Image.new('RGB', (80, 50), (number * 40, 20, 80)) as image:
                saved = store.save(Frame(image, self.at+timedelta(seconds=20*number),
                    Display(1, 0, 0, 80, 50), app, bundle), 'test', temporary=False)
            if metadata:
                save_capture(config, Candidate(saved, 'test', 0, number+1), 'privacy-test')
            paths.append(saved.path)
        model = Model()
        queue = ScreenshotQueue(config, self.day)
        pipeline = ActivityPipeline(config.home, model, config)
        return config, paths, model, queue, pipeline

    def execute(self, mode, config, model, queue, pipeline, event=None):
        if mode == 'auto':
            return queue.step(pipeline, cancel_event=event)
        return backfill_day(config, self.day, interpreter=model, cancel_event=event)

    def test_content_hit_deletes_image_metadata_and_leaves_clean_frames(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode)
                def text(path):
                    return ['sk-proj-synthetic'] if path == paths[0] else ['ordinary document']
                with patch('scening.sensitive_guard.ocr_lines', side_effect=text) as ocr:
                    result = self.execute(mode, config, model, queue, pipeline)
                self.assertEqual(ocr.call_count, 3)
                self.assertFalse(paths[0].exists())
                self.assertFalse(metadata_path(paths[0]).exists())
                self.assertTrue(all(path.exists() for path in paths[1:]))
                self.assertEqual([len(frames) for frames in model.calls], [2])
                index = json.loads((config.screenshotDir/self.day/'index.json').read_text())
                self.assertEqual(len(index['images']), 2)
                self.assertTrue(all(item['analyzed'] for item in index['images']))
                if mode == 'manual':
                    self.assertEqual((result['privacyBlocked'], result['processed'], result['remaining']), (1, 2, 0))
                    self.assertEqual(result['remainingFiles'], [])
                    self.assertEqual(result['state'], 'completed')
                with patch('scening.sensitive_guard.ocr_lines') as again:
                    self.execute(mode, config, model, ScreenshotQueue(config, self.day), pipeline)
                again.assert_not_called()
                self.assertEqual(len(model.calls), 1)

    def test_all_sensitive_images_disappear_from_next_scan(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode)
                with patch('scening.sensitive_guard.ocr_lines', return_value=['sk-proj-synthetic']):
                    result = self.execute(mode, config, model, queue, pipeline)
                self.assertFalse(any(path.exists() or metadata_path(path).exists() for path in paths))
                self.assertEqual(rebuild_day(config, self.day)['images'], [])
                self.assertEqual(model.calls, [])
                with patch('scening.sensitive_guard.ocr_lines') as again:
                    self.execute(mode, config, model, ScreenshotQueue(config, self.day), pipeline)
                again.assert_not_called()
                if mode == 'manual':
                    self.assertEqual((result['privacyBlocked'], result['remaining'], result['state']), (3, 0, 'completed'))

    def test_blacklisted_application_uses_existing_l0_and_skips_ocr(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode, app='微信', bundle='com.tencent.xinWeChat')
                with patch('scening.sensitive_guard.ocr_lines') as ocr:
                    self.execute(mode, config, model, queue, pipeline)
                ocr.assert_not_called()
                self.assertFalse(any(path.exists() for path in paths))
                self.assertEqual(model.calls, [])

    def test_ocr_failure_preserves_bytes_and_retries_successfully(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode)
                before = {p: (p.read_bytes(), metadata_path(p).read_bytes()) for p in paths}
                with patch('scening.sensitive_guard.ocr_lines', side_effect=RuntimeError('synthetic unavailable')):
                    if mode == 'auto':
                        with self.assertRaisesRegex(RuntimeError, 'OCR'):
                            self.execute(mode, config, model, queue, pipeline)
                        self.assertEqual(queue.step(pipeline), 'waiting_retry')
                    else:
                        result = self.execute(mode, config, model, queue, pipeline)
                        self.assertEqual((result['remaining'], result['privacyBlocked'], result['state']), (3, 0, 'partial'))
                        self.assertTrue(result['errors'])
                self.assertEqual(model.calls, [])
                for path in paths:
                    self.assertEqual((path.read_bytes(), metadata_path(path).read_bytes()), before[path])
                with patch('scening.sensitive_guard.ocr_lines', return_value=['ordinary document']):
                    with patch('scening.screenshot_queue.time.monotonic', return_value=queue.retry_deadline+1):
                        self.execute(mode, config, model, queue, pipeline)
                self.assertEqual(len(model.calls), 1)
                self.assertTrue(all(item['analyzed'] for item in rebuild_day(config, self.day)['images']))

    def test_legacy_images_without_metadata_are_checked_and_deleted(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode, count=1, metadata=False)
                with patch('scening.sensitive_guard.ocr_lines', return_value=['sk-proj-synthetic']):
                    self.execute(mode, config, model, queue, pipeline)
                self.assertFalse(paths[0].exists())
                self.assertEqual(model.calls, [])

    def test_cancel_during_ocr_preserves_image_and_metadata(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode)
                event = threading.Event()
                def text(path):
                    event.set()
                    return ['sk-proj-synthetic']
                with patch('scening.sensitive_guard.ocr_lines', side_effect=text):
                    if mode == 'auto':
                        with self.assertRaises(AnalysisCancelled):
                            self.execute(mode, config, model, queue, pipeline, event)
                    else:
                        result = self.execute(mode, config, model, queue, pipeline, event)
                        self.assertEqual(result['state'], 'cancelled')
                        self.assertEqual(result['errors'], [])
                self.assertTrue(all(p.exists() and metadata_path(p).exists() for p in paths))
                self.assertEqual(model.calls, [])

    def test_image_delete_failure_preserves_application_metadata(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode, count=1, app='微信', bundle='com.tencent.xinWeChat')
                unlink = Path.unlink
                def deny(path, *args, **kwargs):
                    if path == paths[0]:
                        raise PermissionError('synthetic delete denied')
                    return unlink(path, *args, **kwargs)
                with patch.object(Path, 'unlink', deny):
                    if mode == 'auto':
                        with self.assertRaises(PermissionError):
                            self.execute(mode, config, model, queue, pipeline)
                    else:
                        result = self.execute(mode, config, model, queue, pipeline)
                        self.assertEqual(result['remaining'], 1)
                        self.assertTrue(result['errors'])
                self.assertTrue(paths[0].exists() and metadata_path(paths[0]).exists())
                self.assertEqual(model.calls, [])

    def test_disabled_privacy_keeps_existing_passthrough(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode)
                config = config.with_overrides(privacy={**config.privacy.model_dump(), 'enabled': False})
                queue = ScreenshotQueue(config, self.day)
                pipeline = ActivityPipeline(config.home, model, config)
                with patch('scening.sensitive_guard.ocr_lines') as ocr:
                    self.execute(mode, config, model, queue, pipeline)
                ocr.assert_not_called()
                self.assertEqual(len(model.calls), 1)
                self.assertTrue(all(p.exists() for p in paths))

    def test_already_analyzed_images_keep_originals(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode)
                with patch('scening.sensitive_guard.ocr_lines', return_value=['ordinary document']):
                    self.execute(mode, config, model, queue, pipeline)
                with patch('scening.sensitive_guard.ocr_lines', return_value=['sk-proj-synthetic']) as ocr:
                    self.execute(mode, config, model, ScreenshotQueue(config, self.day), pipeline)
                ocr.assert_not_called()
                self.assertEqual(len(model.calls), 1)
                self.assertTrue(all(p.exists() and metadata_path(p).exists() for p in paths))

    def test_mixed_ocr_failure_keeps_failed_image_pending(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode)
                def text(path):
                    if path == paths[0]:
                        raise OSError('synthetic read error')
                    return ['ordinary document']
                with patch('scening.sensitive_guard.ocr_lines', side_effect=text):
                    if mode == 'auto':
                        with self.assertRaisesRegex(RuntimeError, 'OCR'):
                            self.execute(mode, config, model, queue, pipeline)
                        self.assertEqual(model.calls, [])
                    else:
                        result = self.execute(mode, config, model, queue, pipeline)
                        self.assertEqual((result['processed'], result['remaining'], result['privacyBlocked']), (2, 1, 0))
                        self.assertEqual(len(model.calls[0]), 2)
                self.assertTrue(all(p.exists() and metadata_path(p).exists() for p in paths))

    def test_metadata_delete_failure_updates_index_and_reports_cleanup_error(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode, count=1)
                unlink = Path.unlink
                def deny(path, *args, **kwargs):
                    if path == metadata_path(paths[0]):
                        raise PermissionError('synthetic metadata delete denied')
                    return unlink(path, *args, **kwargs)
                with patch('scening.sensitive_guard.ocr_lines', return_value=['sk-proj-synthetic']):
                    with patch.object(Path, 'unlink', deny):
                        if mode == 'auto':
                            with self.assertRaises(PermissionError):
                                self.execute(mode, config, model, queue, pipeline)
                        else:
                            result = self.execute(mode, config, model, queue, pipeline)
                            self.assertEqual(result['state'], 'partial')
                            self.assertTrue(result['errors'])
                self.assertFalse(paths[0].exists())
                self.assertTrue(metadata_path(paths[0]).exists())
                self.assertEqual(rebuild_day(config, self.day)['images'], [])
                self.assertEqual(model.calls, [])

    def test_index_failure_after_deletion_recovers_from_disk(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode, count=1)
                failures = []
                def rebuild(settings, day):
                    if not paths[0].exists() and not failures:
                        failures.append(True)
                        raise OSError('synthetic index write failure')
                    return rebuild_day(settings, day)
                with patch('scening.sensitive_guard.ocr_lines', return_value=['sk-proj-synthetic']):
                    with patch('scening.screenshot_queue.rebuild_day', side_effect=rebuild):
                        if mode == 'auto':
                            with self.assertRaises(OSError):
                                self.execute(mode, config, model, queue, pipeline)
                        else:
                            result = self.execute(mode, config, model, queue, pipeline)
                            self.assertTrue(result['errors'])
                self.assertEqual(failures, [True])
                self.assertFalse(paths[0].exists() or metadata_path(paths[0]).exists())
                self.assertEqual(rebuild_day(config, self.day)['images'], [])
                with patch('scening.sensitive_guard.ocr_lines') as ocr:
                    self.execute(mode, config, model, queue, pipeline)
                ocr.assert_not_called()
                self.assertEqual(model.calls, [])

    def test_missing_privacy_config_keeps_legacy_compatibility(self):
        for mode in ('auto', 'manual'):
            with self.subTest(mode=mode):
                config, paths, model, queue, pipeline = self.setup_case(mode, count=1)
                config = type(config).model_validate({**config.model_dump(), 'privacy': None})
                queue = ScreenshotQueue(config, self.day)
                pipeline = ActivityPipeline(config.home, model, config)
                with patch('scening.sensitive_guard.ocr_lines') as ocr:
                    self.execute(mode, config, model, queue, pipeline)
                ocr.assert_not_called()
                self.assertEqual(len(model.calls), 1)
                self.assertTrue(paths[0].exists())

    def test_live_batch_filters_sensitive_frame_and_keeps_previous_end(self):
        config, paths, model, queue, pipeline = self.setup_case('auto')
        with patch('scening.sensitive_guard.ocr_lines', return_value=['ordinary document']):
            queue.step(pipeline)
        target = config.home/'records'/f'{self.day}.json'
        previous = json.loads(target.read_text())[0]
        store = FrameStore(config.screenshotDir, config.scening.jpegQuality)
        self.addCleanup(store.close)
        new = []
        for number in range(3, 6):
            with Image.new('RGB', (80, 50), (80, 20, 80)) as image:
                saved = store.save(Frame(image, self.at+timedelta(seconds=20*number),
                    Display(1, 0, 0, 80, 50), 'Notes', 'com.apple.Notes'), 'new', temporary=False)
            save_capture(config, Candidate(saved, 'new', 0, number+1), 'privacy-test')
            new.append(saved.path)
        def text(path):
            return ['sk-proj-synthetic'] if path == new[0] else ['ordinary document']
        with patch('scening.sensitive_guard.ocr_lines', side_effect=text):
            self.assertEqual(queue.step(pipeline), 'analyzed')
        rows = json.loads(target.read_text())
        self.assertEqual(rows[0], previous)
        self.assertEqual([len(frames) for frames in model.calls], [3, 2])
        self.assertFalse(new[0].exists() or metadata_path(new[0]).exists())
