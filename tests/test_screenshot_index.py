"""按日截图索引：报告为唯一分析依据，文件/CLI与索引写入使用真实实现。"""
from datetime import datetime, timedelta, timezone
from contextlib import closing
import fcntl
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from scening.capture import Display, Frame
from scening.collector import SensingCollector
from scening.frame_store import FrameStore, PreparedImage
from scening.observe_activity import ActivityPipeline
from scening.observer_config import load_config
from scening import runtime_logging

DAY = '2026-10-30'
AT = datetime(2026, 10, 30, 1, tzinfo=timezone(timedelta(hours=8)))


class ScreenshotIndexTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='screenshot-index-', dir=ROOT / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.pictures = self.home / 'pictures'
        self.pictures.mkdir(parents=True)
        self.config = load_config().with_overrides(home=self.home, screenshotDir=self.pictures)
        self.index = self.pictures / DAY / 'index.json'
        logging = patch.object(runtime_logging, 'LOG_PATH', self.root / 'events.log')
        logging.start()
        self.addCleanup(logging.stop)

    def rebuild(self, day=DAY):
        """仅在测试动作时导入待实现模块，目录测试能独立产生行为红灯。"""
        return importlib.import_module('scening.screenshot_index').rebuild_day(self.config, day)

    def image(self, name, color='red'):
        path = self.pictures / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with Image.new('RGB', (30, 20), color) as image:
            image.save(path, 'JPEG')
        return path

    def report(self, paths, *, relative=False, frames=True):
        """保存合法活动结构，路径和图片以本地真实文件为准。"""
        row = {'start': AT.isoformat(), 'end': AT.isoformat(), 'app': 'Editor',
               'bundleId': 'editor', 'analysis': '本地验证：可见活动', 'source': 'screen',
               'screenshot': 'analysis/' + DAY + '/batch.jpg', 'mini': 'analysis/' + DAY + '/batch.jpg'}
        if frames:
            row['frames'] = [{'capturedAt': AT.isoformat(),
                              'screenshot': str(p.relative_to(self.home)) if relative else str(p),
                              'app': 'Editor', 'bundleId': 'editor', 'screen': 1} for p in paths]
        path = self.home / 'records' / (DAY + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps([row], ensure_ascii=False), encoding='utf-8')
        return path

    def saved(self):
        return json.loads(self.index.read_text())

    def command(self):
        return [sys.executable, '-B', '-m', 'scening.screenshot_index', '--day', DAY,
                '--home', str(self.home), '--screenshot-dir', str(self.pictures)]

    def environment(self):
        return {**os.environ, 'PYTHONPATH': str(ROOT / 'src')}

    def test_t01_new_originals_use_date_directory_and_keep_names(self):
        with closing(FrameStore(self.pictures, 80)) as store:
            with Image.new('RGB', (30, 20)) as image:
                frame = Frame(image, AT, Display(1, 0, 0, 30, 20))
                first = store.save(frame, 'periodic', temporary=False)
                second = store.save(frame, 'periodic', temporary=False)
                event = store.save(frame, 'click_after')
                promoted = store.promote(event, 'action')
            self.assertEqual(first.path.parent, self.pictures / DAY)
            self.assertEqual(first.path.name, DAY + '_01-00-00_m1_periodic.jpg')
            self.assertNotEqual(first.path, second.path)
            self.assertEqual(promoted.path.parent, self.pictures / DAY)

    def test_t02_mixed_layout_paths_order_and_originals(self):
        later = self.image(f'{DAY}/{DAY}_02-00-00_m1_periodic.jpg')
        early = self.image(f'{DAY}_01-00-00_m1_action.jpg')
        same = self.image(f'{DAY}/{DAY}_01-00-00_m2_action.jpg')
        self.image(f'{DAY}/{DAY}_01-00-00_batch.jpg')
        self.image(f'.events-other/{DAY}_00-00-00_m1_action.jpg')
        self.report([later], relative=True)
        self.rebuild()
        rows = self.saved()['images']
        self.assertEqual([r['file'] for r in rows], [str(same.relative_to(self.pictures)), early.name, str(later.relative_to(self.pictures))])
        self.assertEqual([r['analyzed'] for r in rows], [False, False, True])
        self.assertEqual([r['capturedAt'] for r in rows], [DAY + 'T01:00:00', DAY + 'T01:00:00', DAY + 'T02:00:00'])

    def test_t03_report_frames_are_the_only_analysis_source(self):
        original = self.image(f'{DAY}_01-00-00_m1_action.jpg')
        self.report([original])
        self.rebuild()
        self.assertTrue(self.saved()['images'][0]['analyzed'])
        self.report([original], frames=False)
        self.rebuild()
        self.assertFalse(self.saved()['images'][0]['analyzed'])
        self.assertTrue(self.saved()['issues'])

    def test_t04_empty_invalid_days_and_bad_reports_preserve_index(self):
        self.rebuild()
        self.assertEqual(self.saved()['images'], [])
        before = self.index.read_bytes()
        with self.assertRaises(ValueError): self.rebuild('../outside')
        report = self.home / 'records' / (DAY + '.json')
        report.parent.mkdir(parents=True, exist_ok=True)
        for invalid in ['{', '{}', '[{"frames": []}]']:
            report.write_text(invalid)
            with self.assertRaises(ValueError): self.rebuild()
            self.assertEqual(self.index.read_bytes(), before)

    def test_t05_corrupt_and_missing_index_rebuild_identically(self):
        original = self.image(f'{DAY}_01-00-00_m1_action.jpg')
        self.report([original])
        self.rebuild()
        before = self.index.read_bytes()
        self.index.write_text('{broken')
        self.rebuild()
        self.assertEqual(self.index.read_bytes(), before)
        self.index.unlink()
        self.rebuild()
        self.assertEqual(self.index.read_bytes(), before)

    def test_t06_failed_replace_preserves_old_index(self):
        self.rebuild()
        before = self.index.read_bytes()
        self.image(f'{DAY}_01-00-00_m1_action.jpg')
        with patch('scening.screenshot_index.os.replace', side_effect=OSError('写入失败')):
            with self.assertRaises(OSError): self.rebuild()
        self.assertEqual(self.index.read_bytes(), before)
        self.assertEqual(list(self.index.parent.glob('*.tmp')), [])

    def test_t07_pipeline_updates_index_and_extension_stays_unanalyzed(self):
        class Model:
            def analyze(self, image, frames=None): return '可见事实：验证活动。'
        pipeline = ActivityPipeline(self.home, Model(), self.config)
        with closing(FrameStore(self.pictures, 80)) as store:
            for number in range(6):
                at = AT + timedelta(seconds=number)
                with Image.new('RGB', (30, 20)) as image:
                    saved = store.save(Frame(image, at, Display(1, 0, 0, 30, 20)), 'periodic', temporary=False)
                pipeline.process(PreparedImage(saved.path, saved.path, saved.size, saved.size), at, 'Editor', 'editor')
        self.assertEqual([r['analyzed'] for r in self.saved()['images']], [True] * 3 + [False] * 3)
        self.assertEqual(len(json.loads((self.home / 'records' / (DAY + '.json')).read_text())), 1)

    def test_t08_collector_publishes_index_before_queue_consumption(self):
        collector = SensingCollector(self.config, backend=object(), app_provider=lambda *_: ('Editor', 'editor'))
        self.addCleanup(collector.store.close)
        for number in range(self.config.scening.candidateQueueSize + 1):
            with Image.new('RGB', (30, 20)) as image:
                saved = collector.store.save(Frame(image, AT + timedelta(seconds=number), Display(1, 0, 0, 30, 20)), 'periodic')
            collector._publish(saved, 'periodic')
        rows = self.saved()['images']
        self.assertEqual(len(rows), self.config.scening.candidateQueueSize + 1)
        self.assertTrue(all(not r['analyzed'] for r in rows))

    def test_t09_real_cli_rebuilds_and_preserves_sources(self):
        original = self.image(f'{DAY}_01-00-00_m1_action.jpg')
        report = self.report([original])
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (original, report)}
        run = subprocess.run(self.command(), cwd=ROOT, env=self.environment(), capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        expected = self.index.read_bytes()
        self.index.unlink()
        run = subprocess.run(self.command(), cwd=ROOT, env=self.environment(), capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(self.index.read_bytes(), expected)
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})

    def test_t10_waiting_rebuild_reads_sources_after_day_lock(self):
        original = self.image(f'{DAY}_01-00-00_m1_action.jpg')
        self.rebuild()
        lock_path = self.index.parent / '.index.lock'
        with lock_path.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            command = [sys.executable, '-B', '-c',
                       'from scening.screenshot_index import main; print("ready", flush=True); raise SystemExit(main())',
                       '--day', DAY, '--home', str(self.home), '--screenshot-dir', str(self.pictures)]
            process = subprocess.Popen(command, cwd=ROOT, env=self.environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(process.stdout.readline().strip(), 'ready')
                with self.assertRaises(subprocess.TimeoutExpired): process.wait(timeout=.15)
                self.report([original])
                fcntl.flock(lock, fcntl.LOCK_UN)
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr)
            finally:
                if process.poll() is None: process.kill(); process.wait()
        self.assertTrue(self.saved()['images'][0]['analyzed'])

    def test_t11_missing_referenced_image_is_diagnostic(self):
        absent = self.pictures / (DAY + '_01-00-00_m1_action.jpg')
        self.report([absent])
        self.rebuild()
        self.assertEqual(self.saved()['images'], [])
        self.assertTrue(any('原图' in issue for issue in self.saved()['issues']))

    def test_t12_invalid_frame_day_and_paths_preserve_index(self):
        original = self.image(f'{DAY}_01-00-00_m1_action.jpg')
        report = self.report([original])
        self.rebuild()
        before = self.index.read_bytes()
        valid = json.loads(report.read_text())
        for field, value in [('capturedAt', '2026-10-29T01:00:00+08:00'), ('screenshot', '../outside.jpg')]:
            rows = json.loads(json.dumps(valid))
            rows[0]['frames'][0][field] = value
            report.write_text(json.dumps(rows))
            with self.assertRaises(ValueError): self.rebuild()
            self.assertEqual(self.index.read_bytes(), before)

    def test_t13_index_failure_keeps_successful_report_and_anchor(self):
        class Model:
            def analyze(self, image, frames=None): return '可见事实：验证活动。'
        pipeline = ActivityPipeline(self.home, Model(), self.config)
        with patch('scening.observe_activity.rebuild_day', side_effect=OSError('索引不可写')):
            for number in range(3):
                at = AT + timedelta(seconds=number)
                path = self.image(f'{DAY}_{at:%H-%M-%S}_m1_action.jpg')
                result = pipeline.process(PreparedImage(path, path, (30, 20), (30, 20)), at, 'Editor', 'editor')
        self.assertEqual(result, 'analyzed')
        self.assertIsNotNone(pipeline.anchor)
        self.assertEqual(len(json.loads((self.home / 'records' / (DAY + '.json')).read_text())), 1)
        self.rebuild()
        self.assertTrue(all(row['analyzed'] for row in self.saved()['images']))

    def test_t14_index_failure_keeps_collector_candidate(self):
        collector = SensingCollector(self.config, backend=object(), app_provider=lambda *_: ('Editor', 'editor'))
        self.addCleanup(collector.store.close)
        with Image.new('RGB', (30, 20)) as image:
            saved = collector.store.save(Frame(image, AT, Display(1, 0, 0, 30, 20)), 'periodic')
        with patch('scening.collector.rebuild_day', side_effect=OSError('索引不可写')):
            collector._publish(saved, 'periodic')
        candidate = collector.next_candidate(timeout=0)
        self.assertTrue(candidate.saved.path.is_file())
        self.assertTrue(any(event['result'] == 'index_failed' for event in collector.drain_status()))


if __name__ == '__main__': unittest.main()
