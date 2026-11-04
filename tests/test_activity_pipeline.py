"""活动链路测试；真实图片、JSON与子进程保留，模型仅在指定边界替换。"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import activity_memory as memory
from scening import kmh_interpreter as kmh
from scening import observe_activity as activity
from scening import runtime_logging as images

AT = datetime(2026, 10, 19, 23, 59, 50, tzinfo=timezone(timedelta(hours=8)))

from scening_fixtures import PreparedSource
from scening.capture import Display, Frame
from scening.frame_store import Candidate, FrameStore
from scening.observer_config import load_config

class FakeInterpreter:
    """只替换模型正文，保留调度、图片和文件处理。"""
    def __init__(self):
        self.calls = 0
        self.summary_calls = 0
        self.fail = False
    def analyze(self, mini, frames=None):
        self.calls += 1
        if self.fail:
            raise RuntimeError('injected model failure')
        return '可见事实：测试页面。\n推测：可能在阅读。\n完成状态证据：待确认。'
    def summarize(self, path):
        self.summary_calls += 1
        assert json.loads(path.read_text())['timeline']
        return '可见活动为阅读测试页面，完成状态待确认。'

class ActivityTests(unittest.TestCase):
    def setUp(self):
        source_patch = patch.object(activity, 'SensingCollector', PreparedSource)
        source_patch.start()
        self.addCleanup(source_patch.stop)
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / "tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.log = self.root / 'logs/events.log'
        self.log.parent.mkdir()
        self.log_patch = patch.object(images, 'LOG_PATH', self.log)
        self.log_patch.start()
        self.addCleanup(self.log_patch.stop)
        images.initialize_logging()
        self.store = memory.ActivityMemory(self.home)
        self.model = FakeInterpreter()
        self.config = load_config().with_overrides(home=self.home, screenshotDir=self.home/"pictures")
        self.pipeline = activity.ActivityPipeline(self.home, interpreter=self.model, config=self.config)
        self.frames = FrameStore(self.config.screenshotDir, self.config.scening.jpegQuality)
        self.addCleanup(self.frames.close)
    def record(self, at=AT):
        return {'start':at.isoformat(), 'end':at.isoformat(), 'app':'Browser', 'bundleId':'browser', 'analysis':'可见事实：页面', 'source':'screen', 'screenshot':'screenshot/test.png', 'mini':'screenshot/test_mini.png'}
    def prepared(self, at=AT, color='black'):
        with Image.new('RGB',(200,100),color) as image:
            saved=self.frames.save(Frame(image,at,Display(1,0,0,200,100)), 'periodic', temporary=False)
        return Candidate(saved,'periodic').prepared
    def test_t1_append_extend_preserves_other_fields(self):
        record=self.record()
        record['extension']={'preserved':True}
        self.store.append(record)
        anchor=self.record(AT+timedelta(seconds=1))
        self.store.append(anchor)
        path=self.home/'records/2026-10-19.json'
        before=json.loads(path.read_text())
        self.store.extend(anchor,AT+timedelta(seconds=5))
        after=json.loads(path.read_text())
        expected=json.loads(json.dumps(before))
        expected[-1]['end']=(AT+timedelta(seconds=5)).isoformat(timespec='seconds')
        self.assertEqual(after,expected)
        self.assertEqual(len(after),2)
        with self.assertRaises(ValueError):
            self.store.extend(anchor,AT+timedelta(seconds=3))
        self.assertEqual(json.loads(path.read_text()),after)
    def test_t2_corrupt_and_invalid_records_are_preserved(self):
        path=self.home/'records/2026-10-19.json'
        path.parent.mkdir(parents=True)
        for body in ['broken', '{}', json.dumps([dict(self.record(),mini='../escape.png')])]:
            path.write_text(body)
            with self.assertRaises(Exception):
                self.store.append(self.record())
            self.assertEqual(path.read_text(),body)
    def test_t2_atomic_replace_failure_preserves_original(self):
        self.store.append(self.record())
        path=self.home/'records/2026-10-19.json'
        before=path.read_bytes()
        with patch.object(memory.os,'replace',side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                self.store.append(self.record(AT+timedelta(seconds=1)))
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(list(path.parent.glob('*.tmp')),[])
    def test_t3_same_changed_app_and_failure_recovery(self):
        start=AT-timedelta(minutes=1)
        def batch(offset,color='black',app='Browser',bundle='browser'):
            for index in range(3):
                at=start+timedelta(seconds=offset+index)
                result=self.pipeline.process(self.prepared(at,color),at,app,bundle)
            return result
        self.assertEqual(batch(0),'analyzed')
        self.assertEqual(batch(3),'extended')
        self.assertEqual(self.model.calls,1)
        batch(6,'white')
        self.assertEqual(self.model.calls,2)
        self.model.fail=True
        with self.assertRaises(RuntimeError):
            batch(9,app='Editor',bundle='editor')
        self.model.fail=False
        batch(12,'white')
        self.assertEqual(self.model.calls,4)
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))),15)
    def test_t4_cross_day_reanalyzes_and_keeps_previous_file(self):
        for index in range(3):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.prepared(at),at,'Browser','browser')
        old=self.home/'records/2026-10-19.json'
        before=old.read_bytes()
        tomorrow=AT+timedelta(seconds=20)
        for index in range(3):
            at=tomorrow+timedelta(seconds=index)
            self.pipeline.process(self.prepared(at),at,'Browser','browser')
        self.assertEqual(self.model.calls,2)
        self.assertEqual(old.read_bytes(),before)
        self.assertTrue((self.home/'records/2026-10-20.json').exists())
    def test_t5_real_subprocess_boundaries(self):
        for code,valid in [('import sys;sys.stderr.write("x"*100000);print("正文")',True),('print("   ")',False),('raise SystemExit(2)',False),('import time;time.sleep(5)',False)]:
            engine=kmh.KMHInterpreter(self.home,timeout=.2,command=[sys.executable,'-c',code])
            if valid:
                self.assertEqual(engine.run('测试'),'正文')
            else:
                with self.assertRaises(RuntimeError):
                    engine.run('测试')

    def test_t5_missing_cli_reason_is_preserved_without_stderr_secrets(self):
        """KMH非零退出保留可操作错误码，原始stderr中的敏感内容留在进程日志。"""
        command=[sys.executable,'-c','import sys;sys.stderr.write("private-token=example\\ndsh: UNKNOWN: ZCODE_CLI_MISSING\\n");raise SystemExit(1)']
        engine=kmh.KMHInterpreter(self.home,timeout=1,command=command)
        with self.assertRaisesRegex(RuntimeError,'ZCODE_CLI_MISSING') as caught:
            engine.run('测试')
        self.assertNotIn('private-token',str(caught.exception))
    def test_t6_summary_window_and_manual_trigger(self):
        start=AT-timedelta(seconds=5)
        self.store.append(self.record())
        self.assertEqual(self.pipeline.summarize(start,AT+timedelta(seconds=5),'manual_exit'),'saved')
        data=json.loads((self.home/'summaries/2026-10-19.json').read_text())
        self.assertEqual(data[-1]['trigger'],'manual_exit')
        self.assertEqual(len(data[-1]['timeline']),1)
        self.assertEqual(list((self.home/'kmh').glob('summary-*.json')),[])
        path=self.home/'summaries/2026-10-19.json'
        before=path.read_bytes()
        with patch.object(self.model,'summarize',side_effect=RuntimeError('injected summary failure')):
            with self.assertRaises(RuntimeError):
                self.pipeline.summarize(start,AT+timedelta(seconds=5))
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(list((self.home/'kmh').glob('summary-*.json')),[])
        self.assertEqual(self.pipeline.summarize(AT+timedelta(seconds=1),AT+timedelta(seconds=2)),'empty')
    def test_t6_summary_sends_and_saves_only_text_timeline(self):
        """周期总结只使用时间、应用与分析正文，原活动的图片证据保持完整。"""
        first = self.record(AT-timedelta(seconds=3))
        first['end'] = (AT+timedelta(seconds=1)).isoformat()
        first['frames'] = [dict(capturedAt=first['start'], screenshot='screenshot/source-frame.png', app='Browser', screen=1)]
        first['extension'] = {'localOnly': '保留在活动证据'}
        second = self.record(AT+timedelta(seconds=2))
        second['app'] = 'Editor'
        second['analysis'] = '可见事实：整理实现。推测：在排查问题。完成状态：待确认。'
        for row in (first, second):
            self.store.append(row)
        source = self.home/'records/2026-10-19.json'
        original = source.read_bytes()
        start, end = AT-timedelta(seconds=1), AT+timedelta(seconds=5)
        self.pipeline.gaps = [dict(start=start.isoformat(), end=AT.isoformat(), reason='合成的已知暂停区间')]
        observed = []

        def summarize(path):
            raw = path.read_text()
            snapshot = json.loads(raw)
            observed.extend(snapshot['timeline'])
            self.assertEqual(len(snapshot['timeline']), 2)
            for row in snapshot['timeline']:
                self.assertEqual(set(row), {'start', 'end', 'app', 'analysis'})
            self.assertEqual(snapshot['timeline'][0]['start'], start.isoformat(timespec='seconds'))
            self.assertEqual([row['app'] for row in snapshot['timeline']], ['Browser', 'Editor'])
            self.assertEqual(snapshot['timeline'][1]['analysis'], second['analysis'])
            self.assertEqual(len(snapshot['gaps']), 1)
            self.assertGreater(len(raw.splitlines()), 1)
            return '按应用和分析结论生成的半小时总结。'

        with patch.object(self.model, 'summarize', side_effect=summarize):
            self.assertEqual(self.pipeline.summarize(start, end), 'saved')
        saved = json.loads((self.home/'summaries/2026-10-19.json').read_text())[-1]
        self.assertEqual(saved['timeline'], observed)
        self.assertEqual(original, source.read_bytes())
        self.assertEqual(self.model.calls, 0)

    def test_t6_text_summary_accepts_legacy_full_event_timeline(self):
        """旧总结保留图片字段，新总结接受四字段文字时间表。"""
        legacy = dict(windowStart=(AT-timedelta(seconds=5)).isoformat(), windowEnd=(AT+timedelta(seconds=5)).isoformat(), generatedAt=AT.isoformat(), timeline=[self.record()], gaps=[], summary='旧版总结正文', trigger='periodic')
        target = self.home/'summaries/2026-10-19.json'
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps([legacy], ensure_ascii=False))
        current = {**legacy, 'timeline': [{key: legacy['timeline'][0][key] for key in ('start','end','app','analysis')}], 'summary': '新版文字总结正文'}
        self.store.save_summary(current)
        saved = json.loads(target.read_text())
        self.assertEqual(saved[0], legacy)
        self.assertEqual(saved[1]['timeline'], current['timeline'])
        self.store.save_summary({**current, 'timeline': [self.record()]})
        saved = json.loads(target.read_text())
        self.assertEqual(saved[0], legacy)
        self.assertEqual(saved[2]['timeline'], current['timeline'])

    def test_t6_period_is_1800_and_window_is_fixed(self):
        start=AT-timedelta(seconds=60)
        self.store.append(self.record())
        self.pipeline.summary_tick(1799,start)
        self.assertEqual(self.model.summary_calls,0)
        self.pipeline.summary_tick(1810,start)
        self.assertEqual(self.model.summary_calls,1)
        self.pipeline.summary_tick(1850,start)
        self.assertEqual(self.model.summary_calls,1)
        data=json.loads((self.home/'summaries/2026-10-20.json').read_text())
        self.assertEqual(data[-1]['windowEnd'],(start+timedelta(seconds=1800)).isoformat(timespec='seconds'))

    def test_t8_storage_failure_blocks_overtaking_until_resume(self):
        """正式提交失败保留最早批，当前开启段停止自动越过；采集与日志继续。"""
        prepared=self.prepared()
        append=memory.ActivityMemory.append
        attempts=[]
        def fail_once(store,record):
            attempts.append(record)
            if len(attempts)==1:
                raise OSError('injected record failure')
            return append(store,record)
        with patch.object(activity.permissions,'screen_capture_allowed',return_value=True), patch.object(activity,'frontmost_application',return_value=('Browser','browser')), patch.object(activity,'KMHInterpreter',return_value=self.model), patch.object(memory.ActivityMemory,'append',autospec=True,side_effect=fail_once):
            result=activity.run_activity(config=self.config,interval=.001,count=6)
        self.assertEqual(result,1)
        self.assertEqual(self.model.calls,1)
        entries=[json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertTrue(any(e.get('stage')=='analysis_queue' and e.get('result')=='failed' for e in entries))
        self.assertFalse(any(e.get('result')=='appended' for e in entries))
        self.assertEqual(entries[-1]['attempts'],6)
        self.assertEqual(entries[-1]['failures'],1)

    def test_t9_log_failure_stops_and_cli_errors_are_logged(self):
        """日志失效结束采集，参数错误在系统调用前写日志。"""
        prepared=self.prepared()
        original=images.log_event
        def failure(event):
            if event.get('stage')=='image_prepare':
                raise OSError('injected log failure')
            return original(event)
        with patch.object(activity.permissions,'screen_capture_allowed',return_value=True), patch.object(PreparedSource,'frame_provider',wraps=PreparedSource.frame_provider) as capture, patch.object(activity,'frontmost_application',return_value=('Browser','browser')), patch.object(images,'log_event',side_effect=failure):
            with self.assertRaises(activity.LogUnavailableError):
                activity.run_activity(config=self.config,interval=.001,count=2)
        self.assertEqual(capture.call_count,1)
        self.assertTrue(prepared.original.exists() and prepared.mini.exists())
        self.assertEqual(activity.main(['--count','-1']),2)
        self.assertEqual(activity.main(['--count','invalid']),2)
        entries=[json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertTrue(any(e.get('stage')=='configuration' for e in entries))
        self.assertTrue(any(e.get('stage')=='arguments' for e in entries))

if __name__=='__main__':
    unittest.main()
