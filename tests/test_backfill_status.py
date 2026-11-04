"""桌面补分析查询：真实报告和锁决定状态，查询保持零模型调用。"""
import fcntl
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from scening.observer_config import load_config

DAY = '2026-10-30'


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('scening.screenshot_backfill_status'), '桌面缺少可校验的日期核对入口')
        self.api = importlib.import_module('scening.screenshot_backfill_status')
        self.temp = tempfile.TemporaryDirectory(prefix='backfill-status-', dir='tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = load_config().with_overrides(home=self.root/'home', screenshotDir=self.root/'shots')
        self.config.screenshotDir.mkdir()

    def scan(self, day=DAY):
        return self.api.read_backfill_status(self.config, day)

    def image(self):
        path = self.config.screenshotDir/f'{DAY}_09-00-00_m1_action.jpg'
        path.write_bytes(b'original')
        return path

    def progress(self, **values):
        folder = self.config.home/'backfill'/DAY
        folder.mkdir(parents=True, exist_ok=True)
        target = folder/'latest.json'
        target.write_text(json.dumps(dict(day=DAY, state='running', planned=1, processed=0, errors=[], **values)))
        return folder

    def test_T1_pending_and_stale_completed_cannot_override_report(self):
        self.image()
        folder = self.progress()
        (folder/'latest.json').write_text(json.dumps(dict(day=DAY,state='completed',planned=1,processed=1,errors=[])))
        value = self.scan()
        self.assertEqual((value.total,value.analyzed,value.remaining,value.state), (1,0,1,'idle'))
        self.assertEqual(self.image().read_bytes(), b'original')

    def test_T1_all_analyzed_uses_frames(self):
        path = self.image()
        folder = self.config.home/'records';folder.mkdir(parents=True)
        at = f'{DAY}T09:00:00+08:00'
        row = dict(start=at,end=at,app='未知应用',analysis='可见活动',source='screen',screenshot='batch.jpg',mini='batch.jpg',
                   frames=[dict(capturedAt=at,screenshot=str(path),screen=1)])
        (folder/f'{DAY}.json').write_text(json.dumps([row]))
        value = self.scan()
        self.assertEqual((value.total,value.analyzed,value.remaining,value.state), (1,1,0,'completed'))

    def test_T1_empty_day_is_distinct(self):
        value = self.scan()
        self.assertEqual((value.total,value.remaining,value.state), (0,0,'empty'))

    def test_T2_bad_report_returns_unknown_counts_and_preserves_bytes(self):
        self.image();folder=self.config.home/'records';folder.mkdir(parents=True)
        path=folder/f'{DAY}.json';path.write_text('{broken')
        value=self.scan()
        self.assertEqual(value.state,'error');self.assertIsNone(value.remaining)
        self.assertEqual(path.read_text(),'{broken')

    def test_T2_bad_progress_still_scans_sources(self):
        self.image();folder=self.progress();(folder/'latest.json').write_text('{broken')
        value=self.scan()
        self.assertEqual((value.total,value.remaining,value.state),(1,1,'idle'))

    def test_T3_running_requires_live_lock(self):
        self.image();folder=self.progress()
        with (folder/'.run.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertEqual(self.scan().state,'running')
        self.assertEqual(self.scan().state,'idle')

    def test_T3_cancelled_and_partial_state_with_remaining(self):
        self.image();folder=self.progress()
        for state in ('cancelled','partial','failed'):
            (folder/'latest.json').write_text(json.dumps(dict(day=DAY,state=state,planned=1,processed=0,errors=[])))
            self.assertEqual(self.scan().state,state)

    def test_T3_automatic_queue_hides_previous_manual_progress(self):
        from scening.screenshot_queue import analysis_lock
        self.image();self.progress()
        with analysis_lock(self.config,DAY) as acquired:
            self.assertTrue(acquired)
            value=self.scan()
            self.assertEqual(value.state,'running')
            self.assertEqual((value.planned,value.processed),(0,0))

    def test_T6_today_is_eligible_and_future_is_ineligible(self):
        from datetime import datetime
        day=datetime.now().astimezone().date().isoformat()
        (self.config.screenshotDir/f'{day}_09-00-00_m1_action.jpg').write_bytes(b'original')
        value=self.scan(day)
        self.assertTrue(value.eligible)
        self.assertEqual(value.remaining,1)
        from datetime import timedelta
        self.assertFalse(self.scan((datetime.now().astimezone()+timedelta(days=1)).date().isoformat()).eligible)

    def test_T2_invalid_day_is_rejected(self):
        with self.assertRaises(ValueError):self.scan('../records')


if __name__=='__main__':unittest.main()
