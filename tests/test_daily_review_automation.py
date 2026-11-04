"""每日自动总结：配置、自然日、输入和持久状态的独立验证。"""
from datetime import datetime
from pathlib import Path
import json
import tempfile
import unittest
from scening.observer_config import DailyReviewConfig, load_config

ROOT = Path(__file__).resolve().parents[1]

class DailyConfigTests(unittest.TestCase):
    def test_time_defaults_and_legacy(self):
        config=load_config()
        self.assertEqual(config.dailyReview.scheduledTime,'03:00')
        legacy=DailyReviewConfig.model_validate({'maxChars':321})
        self.assertEqual(legacy.scheduledTime,'03:00')
        self.assertEqual(legacy.maxChars,321)
        self.assertEqual(legacy.maxAutoAttempts,3)
        for value in ['24:00','3:00','03:60','',12]:
            with self.subTest(value=value),self.assertRaises(ValueError):
                DailyReviewConfig.model_validate({**config.dailyReview.model_dump(),'scheduledTime':value})

if __name__=='__main__': unittest.main()

class DayInputTests(unittest.TestCase):
    def setUp(self):
        base=ROOT/'tmp/daily-review-automation';base.mkdir(parents=True,exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=base)
        self.config=load_config().with_overrides(home=Path(self.tmp.name))
    def tearDown(self): self.tmp.cleanup()
    def write(self,folder,day,rows):
        p=self.config.home/folder/f'{day}.json';p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(json.dumps(rows,ensure_ascii=False));return p
    def test_partial_analysis_without_periods_and_strict_error(self):
        from scening.daily_review_input import build_day_input
        row=dict(start='2026-11-01T00:00:00+08:00',end='2026-11-01T12:00:00+08:00',app='Editor',analysis='推进工作，剩余部分待确认',screenshot='a.jpg',mini='a.jpg')
        p=self.write('records','2026-11-01',[row]);original=p.read_bytes()
        data=build_day_input(self.config,'2026-11-01')
        self.assertEqual(len(data['activities']),1)
        self.assertEqual(data['periods'],[])
        self.assertEqual(p.read_bytes(),original)
        from scening.daily_review_state import generate_day
        from unittest.mock import Mock
        model=Mock();model.run.return_value='仅活动分析也能形成完整日报告'
        result=generate_day(self.config,'2026-11-01',interpreter=model)
        self.assertEqual(result.phase,'succeeded')
        self.assertEqual(result.report.sourceCount,0)
        self.assertEqual(result.report.sourceActivityCount,1)
        self.assertEqual(p.read_bytes(),original)
        self.write('records','2026-11-01',[{}])
        with self.assertRaises(ValueError):build_day_input(self.config,'2026-11-01')
    def test_cross_midnight_and_lossless_long_text(self):
        from scening.daily_review_input import build_day_input,encode_input
        period=dict(windowStart='2026-11-01T23:50:00+08:00',windowEnd='2026-11-02T00:10:00+08:00',generatedAt='2026-11-02T00:11:00+08:00',summary='跨日原文不得归到单一天',timeline=[dict(start='2026-11-01T23:50:00+08:00',end='2026-11-01T23:55:00+08:00',app='Editor',analysis='甲'*5000)],gaps=[])
        self.write('summaries','2026-11-02',[period])
        data=build_day_input(self.config,'2026-11-01')
        self.assertEqual(len(data['activities']),1)
        self.assertNotIn('跨日原文不得归到单一天',json.dumps(data,ensure_ascii=False))
        text=encode_input(data)
        self.assertLessEqual(max(map(len,text.splitlines())),2000)
        self.assertEqual(''.join(json.loads(text)['activities'][0]['analysisParts']),'甲'*5000)

    def test_midnight_endpoint_belongs_to_previous_day(self):
        from scening.daily_review_input import build_day_input
        self.write('summaries','2026-11-02',[dict(
            windowStart='2026-11-01T23:30:00+08:00',
            windowEnd='2026-11-02T00:00:00+08:00',
            generatedAt='2026-11-02T00:01:00+08:00',
            summary='午夜前最后半小时的事实',timeline=[],gaps=[])])
        result=build_day_input(self.config,'2026-11-01')
        self.assertEqual(len(result['periods']),1)
        self.assertEqual(result['periods'][0]['summary'],'午夜前最后半小时的事实')

class StateTests(unittest.TestCase):
    setUp=DayInputTests.setUp
    tearDown=DayInputTests.tearDown
    write=DayInputTests.write
    def periods(self,day='2026-11-01'):
        self.write('summaries',day,[dict(windowStart=day+'T00:00:00+08:00',windowEnd=day+'T12:00:00+08:00',generatedAt=day+'T12:01:00+08:00',summary='只有十二小时已分析资料，其他时段待确认',timeline=[],gaps=[])])
    def test_three_attempts_persist_and_full_error(self):
        from scening.daily_review_state import generate_day,inspect_day
        from unittest.mock import Mock
        from datetime import timedelta
        now=datetime.fromisoformat('2026-11-02T08:00:00+08:00');self.periods()
        message='开始\n'+'服务失败详细原因'*700+'\n结尾'
        model=Mock();model.run.side_effect=RuntimeError(message)
        for index in range(3):
            result=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model,now=now+timedelta(seconds=61*index))
            self.assertEqual(result.autoAttempts,index+1)
        self.assertEqual(result.phase,'failed');self.assertEqual(result.lastError.message,message)
        again=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model,now=now+timedelta(hours=2))
        self.assertEqual(model.run.call_count,3);self.assertEqual(again.autoAttempts,3)
        self.assertEqual(inspect_day(self.config,'2026-11-01',now=now).lastError.message,message)
    def test_wait_starts_after_failure_finishes_and_second_attempt_succeeds(self):
        from scening.daily_review_state import generate_day
        from unittest.mock import Mock
        from datetime import timedelta
        self.periods();clock=[datetime.fromisoformat('2026-11-02T03:00:00+08:00')]
        def fail(*args,**kwargs):
            clock[0]+=timedelta(seconds=10)
            raise RuntimeError('耗时十秒后失败')
        model=Mock();model.run.side_effect=fail
        first=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model,now=lambda:clock[0])
        self.assertEqual(first.finishedAt.second,10)
        self.assertEqual(first.nextAttemptAt.isoformat(),'2026-11-02T03:01:10+08:00')
        from scening.daily_review_state import list_due_days
        self.assertEqual(list_due_days(self.config,now=clock[0]).nextCheckAt,first.nextAttemptAt)
        clock[0]=first.nextAttemptAt-timedelta(seconds=1)
        waiting=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model,now=lambda:clock[0])
        self.assertEqual(waiting.phase,'waiting_retry');self.assertEqual(model.run.call_count,1)
        clock[0]=first.nextAttemptAt;model.run.side_effect=None;model.run.return_value='第二次成功的报告'
        ready=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model,now=lambda:clock[0])
        self.assertEqual(ready.phase,'succeeded');self.assertEqual(ready.autoAttempts,2)
        self.assertIsNone(ready.nextAttemptAt);self.assertIsNone(ready.lastError)

    def test_report_failure_is_visible_and_manual_recovery(self):
        from scening.daily_review_state import generate_day,inspect_day,mark_presented
        from unittest.mock import Mock
        self.periods();model=Mock();model.run.return_value='昨日完整报告'
        now=datetime.fromisoformat('2026-11-02T08:00:00+08:00')
        result=generate_day(self.config,'2026-11-01',interpreter=model,now=now)
        self.assertEqual(result.phase,'succeeded');self.assertFalse(result.canSummarize)
        old=(self.config.home/'daily-reviews/2026-11-01.json').read_bytes()
        model.run.side_effect=RuntimeError('重新生成的真实原因')
        failed=generate_day(self.config,'2026-11-01',interpreter=model,now=now)
        self.assertEqual(failed.phase,'failed');self.assertEqual(failed.report.response,'昨日完整报告')
        self.assertEqual((self.config.home/'daily-reviews/2026-11-01.json').read_bytes(),old)
        self.assertIn('真实原因',inspect_day(self.config,'2026-11-01',now=now).lastError.message)
        model.run.side_effect=None;model.run.return_value='恢复后的报告'
        result=generate_day(self.config,'2026-11-01',interpreter=model,now=now)
        marked=mark_presented(self.config,'2026-11-01',now=now,revision=result.revision)
        self.assertEqual(marked.presentedOn,'2026-11-02')
    def test_calendar_button_and_historical_candidates(self):
        from scening.daily_review_state import inspect_day,list_due_days
        now=datetime.fromisoformat('2026-11-02T08:00:00+08:00')
        self.periods();self.periods('2026-10-31');self.periods('2026-11-02')
        self.assertEqual(list_due_days(self.config,now=now).days,['2026-11-01','2026-10-31'])
        self.assertTrue(inspect_day(self.config,'2026-11-01',now=now).canSummarize)
        self.assertFalse(inspect_day(self.config,'2026-11-02',now=now).canSummarize)
        self.assertFalse(inspect_day(self.config,'2026-11-01',now=now.replace(hour=2)).canSummarize)

    def test_actual_process_preserves_long_error(self):
        from scening.daily_review_state import generate_day,inspect_day
        self.periods()
        message='scene-observer: SERVER: 开始\n'+'服务端响应详情'*900+'\n完整结尾'
        launcher=self.config.home/'model.mjs'
        launcher.write_text('process.stderr.write('+json.dumps(message)+');process.exit(2);')
        config=self.config.with_overrides(kmhLauncher=launcher)
        result=generate_day(config,'2026-11-01')
        self.assertEqual(result.phase,'failed')
        self.assertEqual(result.lastError.details,message)
        self.assertEqual(result.lastError.exitCode,2)
        self.assertEqual(inspect_day(config,'2026-11-01').lastError.details,message)
    def test_committed_report_recovers_without_second_model(self):
        from scening.daily_review_state import generate_day,inspect_day
        from unittest.mock import Mock
        self.periods();model=Mock();model.run.return_value='已保存的完整报告'
        now=datetime.fromisoformat('2026-11-02T08:00:00+08:00')
        first=generate_day(self.config,'2026-11-01',interpreter=model,now=now)
        path=self.config.home/'daily-review-status/2026-11-01.json'
        state=json.loads(path.read_text());state['phase']='running';state['finishedAt']=None
        path.write_text(json.dumps(state))
        interrupted=inspect_day(self.config,'2026-11-01',now=now)
        self.assertTrue(interrupted.needsRecovery)
        recovered=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model,now=now)
        self.assertEqual(recovered.phase,'succeeded');self.assertEqual(model.run.call_count,1)
        self.assertEqual(recovered.report.generationId,first.report.generationId)
    def test_initial_state_save_failure_prevents_model(self):
        from scening.daily_review_state import generate_day
        from unittest.mock import Mock,patch
        self.periods();model=Mock()
        with patch('scening.daily_review_state.os.replace',side_effect=OSError('真实写盘错误')):
            result=generate_day(self.config,'2026-11-01',interpreter=model)
        self.assertEqual(result.phase,'failed');self.assertEqual(model.run.call_count,0)
        self.assertIn('真实写盘错误',result.persistenceError.message)

    def test_invalid_model_response_retries_as_model_failure(self):
        from scening.daily_review_state import generate_day
        from unittest.mock import Mock
        self.periods();model=Mock();model.run.return_value='   '
        result=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model)
        self.assertEqual(result.phase,'waiting_retry')
        self.assertEqual(result.autoAttempts,1)
    def test_due_source_error_is_persisted(self):
        from scening.daily_review_state import generate_day,list_due_days,inspect_day
        self.write('summaries','2026-11-01',[{}])
        now=datetime.fromisoformat('2026-11-02T08:00:00+08:00')
        self.assertIn('2026-11-01',list_due_days(self.config,now=now).days)
        result=generate_day(self.config,'2026-11-01',trigger='automatic',now=now)
        self.assertEqual(result.phase,'failed')
        self.assertIn('windowStart',result.lastError.message)
        self.periods()
        self.assertEqual(inspect_day(self.config,'2026-11-01',now=now).phase,'failed')
    def test_report_save_failure_preserves_old_and_exact_reason(self):
        from scening.daily_review_state import generate_day
        from unittest.mock import Mock,patch
        self.periods();model=Mock();model.run.return_value='上一次完整报告'
        generate_day(self.config,'2026-11-01',interpreter=model)
        target=self.config.home/'daily-reviews/2026-11-01.json'
        original=target.read_bytes()
        with patch('scening.daily_review_report._save',side_effect=OSError('报告原子替换失败的原始理由')):
            result=generate_day(self.config,'2026-11-01',interpreter=model)
        self.assertEqual(result.phase,'failed')
        self.assertEqual(result.lastError.source,'storage')
        self.assertEqual(result.lastError.message,'报告原子替换失败的原始理由')
        self.assertEqual(target.read_bytes(),original)
    def test_automatic_job_preserves_unreadable_existing_report(self):
        from scening.daily_review_state import generate_day,inspect_day
        from unittest.mock import Mock
        self.periods();target=self.config.home/'daily-reviews/2026-11-01.json'
        target.parent.mkdir();target.write_text('{broken report')
        original=target.read_bytes();model=Mock();model.run.return_value='自动新报告'
        view=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model)
        self.assertEqual(view.phase,'failed')
        self.assertEqual(target.read_bytes(),original)
        self.assertEqual(model.run.call_count,0)
        self.assertTrue(inspect_day(self.config,'2026-11-01').canSummarize)
    def test_empty_check_allows_later_partial_analysis(self):
        from scening.daily_review_state import generate_day,list_due_days
        from unittest.mock import Mock
        model=Mock();model.run.return_value='后续十二小时分析的完整报告'
        before=datetime.fromisoformat('2026-11-01T08:00:00+08:00')
        empty=generate_day(self.config,'2026-11-01',interpreter=model,now=before)
        self.assertEqual(empty.phase,'empty');self.assertEqual(model.run.call_count,0)
        self.periods()
        after=datetime.fromisoformat('2026-11-02T08:00:00+08:00')
        self.assertIn('2026-11-01',list_due_days(self.config,now=after).days)
        result=generate_day(self.config,'2026-11-01',trigger='automatic',interpreter=model,now=after)
        self.assertEqual(result.phase,'succeeded');self.assertEqual(result.autoAttempts,1)
    def test_calendar_and_dst_due_boundaries(self):
        from scening.daily_review_state import due_at
        from zoneinfo import ZoneInfo
        for day,expected in [('2026-12-31','2027-01-01'),('2028-02-29','2028-03-01')]:
            self.assertEqual(due_at(self.config,day).date().isoformat(),expected)
        ny=ZoneInfo('America/New_York')
        spring=self.config.with_overrides(dailyReview={**self.config.dailyReview.model_dump(),'scheduledTime':'02:30'})
        due=due_at(spring,'2027-03-13',datetime(2027,3,14,tzinfo=ny))
        self.assertEqual((due.hour,due.minute),(3,30))
        fall=self.config.with_overrides(dailyReview={**self.config.dailyReview.model_dump(),'scheduledTime':'01:30'})
        first=due_at(fall,'2026-10-31',datetime(2026,11,1,tzinfo=ny))
        self.assertEqual(first.fold,0)
    def test_repeated_hour_uses_absolute_due_and_retry_time(self):
        from scening.daily_review_state import inspect_day,generate_day
        from unittest.mock import Mock
        from zoneinfo import ZoneInfo
        ny=ZoneInfo('America/New_York');self.periods('2026-10-31')
        config=self.config.with_overrides(dailyReview={**self.config.dailyReview.model_dump(),'scheduledTime':'01:30'})
        second=datetime(2026,11,1,1,15,tzinfo=ny,fold=1)
        self.assertTrue(inspect_day(config,'2026-10-31',now=second).canSummarize)
        model=Mock();model.run.side_effect=RuntimeError('合成连接错误')
        first=datetime(2026,11,1,1,59,tzinfo=ny,fold=0)
        failed=generate_day(config,'2026-10-31',trigger='automatic',interpreter=model,now=first)
        self.assertEqual(failed.nextAttemptAt.timestamp()-first.timestamp(),60)
