"""当天统一队列：真实文件、索引、锁、报告和主循环，模型与系统取屏受控。"""
from datetime import datetime, timedelta
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import subprocess
import os
import unittest
from unittest.mock import patch

from PIL import Image
from scening.observer_config import load_config
from scening.capture import Display, Frame
from scening.frame_store import FrameStore, Candidate
from scening.observe_activity import ActivityPipeline
from scening.screenshot_index import rebuild_day
from scening_fixtures import PreparedSource


class Model:
    def __init__(self, callback=None):
        self.calls=[];self.callback=callback
    def analyze(self, image, frames=None):
        self.calls.append(frames)
        if self.callback:self.callback(len(self.calls))
        return '可见活动：核对截图。意图推测：验证队列。观察到的变化：页面文字变化。'


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('scening.screenshot_queue'),'缺少同日统一队列')
        self.api=importlib.import_module('scening.screenshot_queue')
        self.meta=importlib.import_module('scening.capture_metadata')
        self.temp=tempfile.TemporaryDirectory(prefix='today-queue-',dir='tmp');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.day=datetime.now().astimezone().date().isoformat()
        self.at=datetime.now().astimezone().replace(hour=0,minute=0,second=0,microsecond=0)
        self.config=load_config().with_overrides(home=self.root/'home',screenshotDir=self.root/'shots')
        self.store=FrameStore(self.config.screenshotDir,self.config.scening.jpegQuality);self.addCleanup(self.store.close)

    def pictures(self,count,start=0,generation=0,app='Editor'):
        paths=[]
        for i in range(start,start+count):
            at=self.at+timedelta(seconds=i*20)
            with Image.new('RGB',(80,50),(i*20%255,30,80)) as image:
                saved=self.store.save(Frame(image,at,Display(1,0,0,80,50),app,'test.editor'),'test',temporary=False)
            candidate=Candidate(saved,'test',generation,i+1)
            self.meta.save_capture(self.config,candidate,'capture-run')
            paths.append(saved.path)
        return paths

    def pipeline(self,model=None):return ActivityPipeline(self.config.home,model or Model(),self.config)
    def index(self):return rebuild_day(self.config,self.day)

    def test_T1_backlog_before_new_and_partial_tail(self):
        paths=self.pictures(5);model=Model();queue=self.api.ScreenshotQueue(self.config,self.day)
        pipeline=self.pipeline(model)
        self.assertEqual(queue.step(pipeline),'analyzed')
        paths+=self.pictures(3,start=5)
        self.assertEqual(queue.step(pipeline),'analyzed')
        self.assertEqual(queue.step(pipeline),'analyzed')
        self.assertEqual([len(f) for f in model.calls],[3,2,3])
        self.assertEqual([f['capturedAt'] for batch in model.calls for f in batch],[(self.at+timedelta(seconds=i*20)).isoformat() for i in range(8)])
        self.assertEqual(queue.step(pipeline),'waiting')
        self.assertTrue(all(i['analyzed'] for i in self.index()['images']))
        self.assertTrue(all(path.exists() for path in paths))

    def test_T2_live_merge_consumed_once_and_next_enable_rescans(self):
        queue=self.api.ScreenshotQueue(self.config,self.day);model=Model();pipeline=self.pipeline(model)
        self.pictures(3);self.assertEqual(queue.step(pipeline),'analyzed')
        # 同色图与同应用保留既有无变化行为，当前段只消费一次。
        for i in range(3,6):
            at=self.at+timedelta(seconds=i*20)
            with Image.new('RGB',(80,50),(40,30,80)) as image:
                saved=self.store.save(Frame(image,at,Display(1,0,0,80,50),'Editor','test.editor'),'same',temporary=False)
            self.meta.save_capture(self.config,Candidate(saved,'same',0,i+1),'capture-run')
        self.assertEqual(queue.step(pipeline),'extended')
        self.assertEqual(queue.step(pipeline),'waiting');self.assertEqual(len(model.calls),1)
        queue=self.api.ScreenshotQueue(self.config,self.day)
        self.assertEqual(queue.step(self.pipeline(model)),'analyzed')
        self.assertEqual(len(model.calls),2)

    def test_T3_today_allowed_future_rejected(self):
        from scening.screenshot_backfill import backfill_day
        self.pictures(1);model=Model()
        self.assertEqual(backfill_day(self.config,self.day,interpreter=model)['remaining'],0)
        with self.assertRaises(ValueError):backfill_day(self.config,(self.at+timedelta(days=1)).date().isoformat(),interpreter=model)

    def test_T4_shared_lock_and_two_workers_no_duplicate(self):
        from scening.screenshot_backfill import backfill_day
        self.pictures(4);entered=threading.Event();release=threading.Event();errors=[]
        def hold(_):entered.set();self.assertTrue(release.wait(5))
        first=Model(hold);second=Model();queue=self.api.ScreenshotQueue(self.config,self.day)
        def automatic():
            try:queue.step(self.pipeline(first))
            except BaseException as error:errors.append(error)
        result=[]
        def manual():
            try:result.append(backfill_day(self.config,self.day,interpreter=second))
            except BaseException as error:errors.append(error)
        a=threading.Thread(target=automatic);a.start();self.assertTrue(entered.wait(5))
        b=threading.Thread(target=manual);b.start()
        try:
            with self.api.analysis_lock(self.config,self.day) as acquired:self.assertFalse(acquired)
            self.assertFalse(threading.Event().wait(.05));self.assertEqual(second.calls,[])
        finally:release.set();a.join(5);b.join(5)
        self.assertFalse(a.is_alive() or b.is_alive());self.assertFalse(errors,errors)
        self.assertEqual(len(first.calls)+len(second.calls),2)
        self.assertEqual(result[0]['remaining'],0)
        rows=json.loads((self.config.home/'records'/f'{self.day}.json').read_text())
        references=[f['screenshot'] for row in rows for f in row['frames']]
        self.assertEqual(len(references),len(set(references)));self.assertEqual(len(references),4)

    def test_T5_waiting_lock_can_cancel(self):
        from scening.screenshot_backfill import backfill_day
        self.pictures(1);cancel=threading.Event();result=[];errors=[];model=Model()
        def run():
            try:result.append(backfill_day(self.config,self.day,interpreter=model,cancel_event=cancel))
            except BaseException as error:errors.append(error)
        with self.api.analysis_lock(self.config,self.day) as acquired:
            self.assertTrue(acquired);worker=threading.Thread(target=run);worker.start()
            cancel.set();worker.join(5)
            self.assertFalse(worker.is_alive());self.assertFalse(errors,errors)
        self.assertEqual(result[0]['state'],'cancelled');self.assertEqual(model.calls,[])

    def test_T6_failure_backoff_retries_same_batch_then_recovers(self):
        config=self.config.with_overrides(analysis={**self.config.analysis.model_dump(),'retryIntervalSeconds':0.4,'maxRetries':2})
        self.pictures(3)
        calls=[]
        def flaky(_):
            calls.append(1)
            if len(calls)<3:raise RuntimeError('controlled failure')
        queue=self.api.ScreenshotQueue(config,self.day)
        with self.assertRaises(RuntimeError):queue.step(self.pipeline(Model(flaky)))
        # 退避等待按失败次数线性递增：第1次失败等1×基数，第2次等2×基数。
        self.assertIn('0.4秒后自动重试同批',queue.retry_hint())
        self.assertEqual(queue.step(self.pipeline(Model())),'waiting_retry')
        self.assertFalse(threading.Event().wait(0.5))
        with self.assertRaises(RuntimeError):queue.step(self.pipeline(Model(flaky)))
        self.assertIn('0.8秒后自动重试同批',queue.retry_hint())
        self.assertEqual(queue.step(self.pipeline(Model())),'waiting_retry')
        self.assertFalse(threading.Event().wait(0.9))
        model=Model();self.assertEqual(queue.step(self.pipeline(model)),'analyzed')
        self.assertEqual(len(model.calls),1);self.assertEqual(len(model.calls[0]),3)
        self.assertEqual(queue.failed_attempts,0)
        self.assertEqual(queue.step(self.pipeline(model)),'waiting')

    def test_T6_failure_exhausts_retries_blocks_and_recovers(self):
        config=self.config.with_overrides(analysis={**self.config.analysis.model_dump(),'retryIntervalSeconds':0.5,'maxRetries':1})
        self.pictures(4)
        def fail(_):raise RuntimeError('controlled failure')
        bad=Model(fail);queue=self.api.ScreenshotQueue(config,self.day)
        # maxRetries=1：首次失败后退避重试一次，重试仍失败才blocked。
        with self.assertRaises(RuntimeError):queue.step(self.pipeline(bad))
        self.assertIn('0.5秒后自动重试同批',queue.retry_hint())
        self.assertEqual(queue.step(self.pipeline(bad)),'waiting_retry')
        self.assertFalse(threading.Event().wait(0.6))
        with self.assertRaises(RuntimeError):queue.step(self.pipeline(bad))
        self.assertIn('重新开启分析或手动补齐失败批后继续',queue.retry_hint())
        self.assertEqual(queue.step(self.pipeline(bad)),'blocked');self.assertEqual(len(bad.calls),2)
        model=Model();again=self.api.ScreenshotQueue(config,self.day)
        again.step(self.pipeline(model));again.step(self.pipeline(model))
        self.assertEqual(queue.step(self.pipeline(model)),'waiting')

    def test_T7_capture_metadata_survives_reload_and_bad_metadata_is_unknown(self):
        paths=self.pictures(1);model=Model()
        self.api.ScreenshotQueue(self.config,self.day).step(self.pipeline(model))
        self.assertEqual(model.calls[0][0]['app'],'Editor')
        path=self.pictures(1,start=1)[0]
        path.with_name(path.name+'.metadata.json').write_text('{bad')
        model=Model();self.api.ScreenshotQueue(self.config,self.day).step(self.pipeline(model))
        self.assertIsNone(model.calls[0][0]['app']);self.assertTrue(paths[0].exists())

    def test_T7_live_partial_interrupt_is_preserved_for_next_enable(self):
        queue=self.api.ScreenshotQueue(self.config,self.day);model=Model();pipeline=self.pipeline(model)
        old=self.pictures(2);self.assertEqual(queue.step(pipeline),'waiting')
        self.pictures(3,start=2,generation=1)
        self.assertEqual(queue.step(pipeline),'analyzed')
        self.assertEqual(len(model.calls),1);self.assertEqual(model.calls[0][0]['capturedAt'],(self.at+timedelta(seconds=40)).isoformat())
        self.assertTrue(all(p.exists() for p in old))
        again=self.api.ScreenshotQueue(self.config,self.day);again.step(self.pipeline(model))
        self.assertEqual(len(model.calls[1]),2)

    def test_T2_collector_overflow_keeps_metadata_and_queue_catches_every_image(self):
        from scening.collector import SensingCollector
        from test_scening import Backend
        config=self.config.with_overrides(scening={**self.config.scening.model_dump(),'candidateQueueSize':1})
        collector=SensingCollector(config,backend=Backend(),app_provider=lambda:('Editor','test.editor'))
        self.addCleanup(collector.close)
        queue=self.api.ScreenshotQueue(config,self.day)
        for i in range(5):
            with Image.new('RGB',(80,50),(i*30,20,50)) as image:
                saved=collector.store.save(Frame(image,self.at+timedelta(seconds=i),Display(1,0,0,80,50),'Editor','test.editor'),'test',temporary=False)
            collector._publish(saved,'test')
        self.assertEqual(collector.candidates.qsize(),1)
        self.assertTrue(any(e['result']=='queue_dropped' for e in collector.drain_status()))
        queue.rescan_backlog()
        model=Model();pipeline=ActivityPipeline(config.home,model,config)
        queue.step(pipeline);queue.step(pipeline)
        self.assertEqual(sum(len(f) for f in model.calls),5)
        self.assertTrue(all(f['app']=='Editor' for batch in model.calls for f in batch))

    def test_T1_real_runtime_starts_with_today_backlog_then_new(self):
        from scening import observe_activity as activity
        self.pictures(4);model=Model()
        with patch.object(activity,'SensingCollector',PreparedSource),patch.object(activity.permissions,'screen_capture_allowed',return_value=True),patch.object(activity,'KMHInterpreter',return_value=model),patch.object(activity,'frontmost_application',return_value=('Editor','editor')):
            self.assertEqual(activity.run_activity(config=self.config,interval=.001,count=3),0)
        self.assertEqual([len(f) for f in model.calls],[3,1,3])
        self.assertTrue(all(i['analyzed'] for i in self.index()['images']))

    def test_T7_bad_report_keeps_capture_running_then_resumes_after_repair(self):
        from scening import observe_activity as activity
        folder=self.config.home/'records';folder.mkdir(parents=True)
        report=folder/f'{self.day}.json';report.write_text('{bad')
        model=Model()
        with patch.object(activity,'SensingCollector',PreparedSource),patch.object(activity.permissions,'screen_capture_allowed',return_value=True),patch.object(activity,'KMHInterpreter',return_value=model):
            self.assertEqual(activity.run_activity(config=self.config,interval=.001,count=2),1)
        self.assertEqual(report.read_text(),'{bad');self.assertEqual(model.calls,[])
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))),2)
        report.write_text('[]')
        queue=self.api.ScreenshotQueue(self.config,self.day)
        self.assertEqual(queue.step(self.pipeline(model)),'analyzed')
        self.assertEqual(len(model.calls[0]),2)

    def test_T1_subsecond_capture_order_overrides_alphabetical_filename(self):
        for micros,tag in [(100000,'z'),(900000,'a')]:
            with Image.new('RGB',(80,50),'blue') as image:
                saved=self.store.save(Frame(image,self.at+timedelta(microseconds=micros),Display(1,0,0,80,50),'Editor','editor'),tag,temporary=False)
            self.meta.save_capture(self.config,Candidate(saved,tag),'subsecond')
        model=Model();self.api.ScreenshotQueue(self.config,self.day).step(self.pipeline(model))
        self.assertEqual([f['capturedAt'] for f in model.calls[0]],[(self.at+timedelta(microseconds=i)).isoformat() for i in [100000,900000]])

    def test_T4_foreign_append_clears_runtime_merge_anchor(self):
        from scening.screenshot_backfill import backfill_day
        from scening.task_store import read_activities
        queue=self.api.ScreenshotQueue(self.config,self.day);model=Model();pipeline=self.pipeline(model)
        self.pictures(3);queue.step(pipeline)
        identity=read_activities(self.config.home,self.day)[0][0]['id']
        self.pictures(1,start=3);backfill_day(self.config,self.day,interpreter=Model())
        for path in self.pictures(3,start=4):
            with Image.new('RGB',(80,50),(40,30,80)) as image:image.save(path)
        self.assertEqual(queue.step(pipeline),'analyzed')
        rows=read_activities(self.config.home,self.day)[0]
        self.assertEqual(len(rows),3);self.assertEqual(rows[0]['id'],identity)

    def test_T4_process_owned_day_lock_is_seen_by_runtime(self):
        self.pictures(3);queue=self.api.ScreenshotQueue(self.config,self.day);model=Model()
        code='''import sys
from pathlib import Path
from scening.observer_config import load_config
from scening.screenshot_queue import analysis_lock
config=load_config().with_overrides(home=Path(sys.argv[1]),screenshotDir=Path(sys.argv[2]))
with analysis_lock(config,sys.argv[3]) as acquired:
 print('held',flush=True)
 sys.stdin.read()
'''
        process=subprocess.Popen([str(Path.cwd()/'.venv/bin/python'),'-B','-c',code,str(self.config.home),str(self.config.screenshotDir),self.day],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'PYTHONPATH':str(Path('src').resolve())})
        try:
            self.assertEqual(process.stdout.readline().strip(),b'held')
            self.assertEqual(queue.step(self.pipeline(model)),'busy');self.assertEqual(model.calls,[])
            process.stdin.close();process.wait(timeout=5)
            self.assertEqual(queue.step(self.pipeline(model)),'analyzed')
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=5)
            process.stdout.close();process.stderr.close()
