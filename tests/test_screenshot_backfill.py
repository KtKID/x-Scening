"""历史截图补分析：只替换模型回复，扫描、拼图、正式报告和索引走真实入口。"""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

from PIL import Image
from scening.observation_generated import ObservationResult
from scening.observer_config import load_config
from scening.task_store import read_activities

DAY = '2026-10-30'


class Model:
    def __init__(self, callback=None):
        self.calls = 0
        self.frames = []
        self.callback = callback

    def analyze(self, image, frames=None):
        self.calls += 1
        self.frames.append(frames)
        if self.callback:
            self.callback(self.calls)
        return ObservationResult(schema_version=1, visible_activity='编辑设计文章',
                                 inferred_intent='推测在调整措辞', stage_and_evidence='正文文字变化',
                                 app_tags=['Chrome'], task_types=['工作'])


class BackfillTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('scening.screenshot_backfill'), '缺少历史补跑入口')
        from scening import screenshot_backfill
        self.api = screenshot_backfill
        self.temp = tempfile.TemporaryDirectory(prefix='backfill-test-', dir='tmp')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = load_config().with_overrides(home=self.home, screenshotDir=self.home/'screenshots')
        self.config.screenshotDir.mkdir()

    def pictures(self, count):
        start = datetime(2026, 10, 30, 9, tzinfo=timezone(timedelta(hours=8)))
        paths = []
        for index in range(count):
            path = self.config.screenshotDir / f"{(start+timedelta(seconds=index*20)):%Y-%m-%d_%H-%M-%S}_m1_action.jpg"
            with Image.new('RGB', (80, 50), (index*20 % 255, 30, 100)) as image:
                image.save(path)
            paths.append(path)
        return paths

    def run_backfill(self, model=None, **kwargs):
        return self.api.backfill_day(self.config, DAY, interpreter=model or Model(), **kwargs)

    def test_T1_T7_full_batch_tail_and_resume(self):
        paths = self.pictures(5); before = [p.read_bytes() for p in paths]
        model = Model();result = self.run_backfill(model)
        self.assertEqual([len(frames) for frames in model.frames], [3, 2])
        self.assertEqual(result['processed'], 5);self.assertEqual(result['remaining'], 0)
        rows, issues = read_activities(self.home, DAY)
        self.assertFalse(issues);self.assertEqual(sum(len(r['frames']) for r in rows), 5)
        self.assertEqual([p.read_bytes() for p in paths], before)
        again = Model();self.assertEqual(self.run_backfill(again)['processed'], 0)
        self.assertEqual(again.calls, 0)

    def test_T2_original_prefix_and_ids_stay_stable(self):
        self.pictures(1)
        folder = self.home/'records';folder.mkdir()
        original = dict(start=f'{DAY}T12:00:00+08:00', end=f'{DAY}T12:01:00+08:00',
                        app='Editor', analysis='已有活动', screenshot='old.jpg', mini='old.jpg', source='screen')
        target = folder/f'{DAY}.json';target.write_text(json.dumps([original], ensure_ascii=False))
        identity = read_activities(self.home, DAY)[0][0]['id']
        self.run_backfill()
        saved = json.loads(target.read_text());self.assertEqual(saved[0], original)
        self.assertEqual(next(r['id'] for r in read_activities(self.home, DAY)[0] if r['analysis']=='已有活动'), identity)

    def test_T3_empty_day(self):
        model = Model();result = self.run_backfill(model)
        self.assertEqual(result['planned'], 0);self.assertEqual(model.calls, 0)

    def test_T1_independent_screenshot_directory(self):
        """正式截图根位于home之外时，复用Memory允许的绝对引用边界。"""
        path=self.pictures(1)[0].resolve()
        config=self.config.with_overrides(home=self.home/'separate-home')
        result=self.api.backfill_day(config,DAY,interpreter=Model())
        self.assertEqual(result['processed'],1)
        rows,issues=read_activities(config.home,DAY)
        self.assertFalse(issues)
        self.assertEqual(rows[0]['frames'][0]['screenshot'],str(path))

    def test_T4_bad_report_keeps_original(self):
        self.pictures(1);folder=self.home/'records';folder.mkdir();target=folder/f'{DAY}.json';target.write_text('{broken')
        with self.assertRaises(ValueError):self.run_backfill()
        self.assertEqual(target.read_text(), '{broken')

    def test_T4_failure_keeps_batch_pending_and_continues(self):
        self.pictures(4)
        def fail_first(call):
            if call == 1:raise RuntimeError('fixture model failure')
        model=Model(fail_first);result=self.run_backfill(model)
        self.assertEqual(model.calls,2);self.assertEqual(result['processed'],1)
        self.assertEqual(result['remaining'],3);self.assertTrue(result['errors'])

    def test_T5_cancel_before_commit_then_resume(self):
        self.pictures(4);cancel=threading.Event()
        model=Model(lambda call: cancel.set() if call==2 else None)
        result=self.run_backfill(model,cancel_event=cancel)
        self.assertEqual(result['processed'],3);self.assertEqual(result['remaining'],1)
        self.assertEqual(result['state'],'cancelled')
        model=Model();self.assertEqual(self.run_backfill(model)['remaining'],0)
        self.assertEqual(model.calls,1)

    def test_T6_future_date_is_outside_scope(self):
        with self.assertRaises(ValueError):
            self.api.backfill_day(self.config,(datetime.now().astimezone()+timedelta(days=1)).date().isoformat(),interpreter=Model())

    def test_T6_same_day_lock(self):
        import fcntl
        folder=self.home.resolve()/'backfill'/DAY;folder.mkdir(parents=True)
        with (folder/'.run.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):self.run_backfill()

    def test_T4_bad_image_keeps_pending_and_valid_image_advances(self):
        paths=self.pictures(2);paths[0].write_bytes(b'broken jpeg')
        model=Model();result=self.run_backfill(model)
        self.assertEqual(result['processed'],1);self.assertEqual(result['remaining'],1)
        self.assertEqual(len(model.frames[0]),1);self.assertEqual(result['state'],'partial')

    def test_T7_already_saved_while_model_runs_skips_duplicate(self):
        from scening.activity_memory import ActivityMemory
        path=self.pictures(1)[0].resolve()
        memory=ActivityMemory(self.home,screenshot_dir=self.config.screenshotDir)
        def save_elsewhere(_):
            memory.append(dict(start=f'{DAY}T09:00:00+08:00',end=f'{DAY}T09:00:00+08:00',
                analysis='其他作业已保存',screenshot=str(path),mini=str(path),source='screen',
                frames=[dict(capturedAt=f'{DAY}T09:00:00+08:00',screenshot=str(path),screen=1)]))
        result=self.run_backfill(Model(save_elsewhere))
        self.assertEqual(result['processed'],0);self.assertEqual(result['skipped'],1)
        self.assertEqual(result['remaining'],0)
        self.assertEqual(len(read_activities(self.home,DAY)[0]),1)

    def test_T2_original_source_change_stops_commit(self):
        self.pictures(1);folder=self.home/'records';folder.mkdir();target=folder/f'{DAY}.json'
        original=dict(start=f'{DAY}T12:00:00+08:00',end=f'{DAY}T12:00:00+08:00',analysis='原观察',screenshot='old.jpg',mini='old.jpg',source='screen')
        target.write_text(json.dumps([original]))
        def change_source(_):
            original['analysis']='外部更新';target.write_text(json.dumps([original]))
        with self.assertRaisesRegex(ValueError,'原始报告前缀已变化'):
            self.run_backfill(Model(change_source))
        self.assertEqual(json.loads(target.read_text()),[original])

    def test_T2_historical_system_application_comes_from_valid_sample(self):
        from scening.activity_evidence import EvidenceStore
        from scening.task_store import digest
        path=self.pictures(1)[0].resolve();folder=self.home/'records';folder.mkdir()
        original=dict(start=f'{DAY}T09:00:00+08:00',end=f'{DAY}T09:05:00+08:00',analysis='已有连续活动',screenshot='old.jpg',mini='old.jpg',source='screen')
        (folder/f'{DAY}.json').write_text(json.dumps([original]))
        reference=read_activities(self.home,DAY)[0][0];at=f'{DAY}T09:00:00+08:00'
        store=EvidenceStore(self.home)
        store.append_batch(reference,[dict(sampleId=digest([str(path),at]),capturedAt=at,runId='r',continuityId='c',sampleSequence=1,app='Editor',bundleId='test.editor',screen=1)])
        evidence=self.home/'activity-evidence'/f'{DAY}.json';before=evidence.read_bytes()
        model=Model();self.run_backfill(model)
        self.assertEqual(model.frames[0][0]['app'],'Editor')
        self.assertEqual(evidence.read_bytes(),before)
