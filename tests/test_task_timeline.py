"""任务MVP：外部模型用可控JSON替身，文件/引用/投影保持真实。"""
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from scening.observer_config import load_config

DAY='2026-10-30'
def row(start='09:00',end='09:01',text='排查登录问题',app='Chrome'):
    return dict(start=f'{DAY}T{start}:00+08:00',end=f'{DAY}T{end}:00+08:00',app=app,analysis=text,screenshot='a.jpg',mini='a.jpg',source='screen')
class Model:
    def __init__(self,reply): self.reply=reply;self.calls=0
    def run(self,*args,**kwargs):
        self.calls+=1
        return self.reply() if callable(self.reply) else json.dumps(self.reply,ensure_ascii=False)
class TaskTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.find_spec('scening.task_timeline')
        self.assertIsNotNone(spec,'MVP缺少任务关联及投影能力')
        self.api=importlib.import_module('scening.task_timeline')
        self.tmp=tempfile.TemporaryDirectory(dir='tmp');self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name); self.config=load_config().with_overrides(home=self.home)
        (self.home/'records').mkdir();self.rows=[row()];self.save()
    def save(self): (self.home/'records'/f'{DAY}.json').write_text(json.dumps(self.rows,ensure_ascii=False))
    def proposal(self):
        records,_=self.api.read_activities(self.home,DAY)
        return dict(tasks=[dict(key='new',title='修复登录',object='登录',goal='修复异常')],assignments=[dict(activityId=r['id'],taskKey='new') for r in records],progress=[dict(taskKey='new',text='已定位异常',kind='observed',completionScope=None,evidence=[dict(activityId=records[0]['id'],sourceSignature=records[0]['signature'],excerpt='排查登录问题')])])
    def organize(self,proposal=None):
        model=Model(proposal or self.proposal());self.api.organize_day(self.config,DAY,interpreter=model);return model
    def view(self):return self.api.project_day(self.config,DAY)

    def test_task_name_prompt_and_ten_character_boundary(self):
        """模型收到复用名称与长度规则，十字符新任务可经真实提交保存。"""
        import yaml
        proposal=self.proposal();proposal['tasks'][0]['title']='一二三四五六七八九十'
        outer=self
        class CheckingModel:
            def run(self,task,patch_path=None):
                patch=yaml.safe_load(patch_path.read_text())
                payload=json.loads(Path(patch[0]['config']['inputFile']).read_text())
                outer.assertIn('如果和已有任务相关联，那关联字段就填写对应任务名',task)
                outer.assertIn('如果没有和已知任务关联，那就起一个任务名，不超过10个字符',task)
                outer.assertIn('已有任务名称保持原样',task)
                title=payload['responseSchema']['$defs']['ProposedTask']['properties']['title']
                outer.assertEqual(title['maxLength'],10)
                return json.dumps(proposal,ensure_ascii=False)
        self.api.organize_day(self.config,DAY,interpreter=CheckingModel())
        self.assertEqual(self.view().tasks[0].title,'一二三四五六七八九十')

    def test_long_new_task_name_preserves_previous_file(self):
        """新名称越界时在文件提交前失败，原任务日文件保持原字节。"""
        self.organize();target=self.home/'task-timeline'/f'{DAY}.json';before=target.read_bytes()
        self.rows.append(row('14:00','14:01','设计新的设置方案'));self.save()
        proposal=self.proposal();proposal['tasks'][0]['title']='一二三四五六七八九十一'
        proposal['assignments']=proposal['assignments'][-1:];proposal['progress']=[]
        with self.assertRaises(ValueError):self.organize(proposal)
        self.assertEqual(target.read_bytes(),before)

    def test_legacy_task_name_is_reused_without_renaming(self):
        """历史长名称可读取，跨批后续关联保持同一身份与完整名称。"""
        self.organize();doc=self.api.read_tasks(self.home,DAY)
        title='梳理Codex插件实现方案与ACP协议适配'
        doc.tasks[0].title=title;identity=doc.tasks[0].taskId
        self.api.atomic_save(self.home/'task-timeline'/f'{DAY}.json',doc)
        self.rows.append(row('14:00','14:01','继续检查插件方案'));self.save()
        fresh=self.api.read_activities(self.home,DAY)[0][-1]
        self.organize(dict(tasks=[],assignments=[dict(activityId=fresh['id'],taskKey=identity)],progress=[]))
        view=self.view()
        self.assertEqual([(task.taskId,task.title) for task in view.tasks],[(identity,title)])
        self.assertEqual([segment.taskId for segment in view.segments],[identity,identity])

    def test_T01_T04_cross_app_stable_identity_end_only(self):
        self.organize();before=self.view(); tid=before.tasks[0].taskId
        self.rows.append(row('14:00','14:01','验证登录','Editor'));self.save()
        p=self.proposal();p['tasks']=[]
        for a in p['assignments']:a['taskKey']=tid
        p['progress']=[];p['assignments']=p['assignments'][-1:];self.organize(p)
        self.assertEqual([t.taskId for t in self.view().tasks],[tid])
        self.rows[-1]['end']=f'{DAY}T14:03:00+08:00';self.save()
        model=self.organize(p);self.assertEqual(model.calls,0)
        self.assertEqual(len(self.view().segments),2)
    def test_T02_T03_T14_unknown_and_same_day(self):
        p=self.proposal();p['tasks']=[];p['progress']=[];p['assignments'][0]['taskKey']=None
        self.organize(p);v=self.view();self.assertEqual(v.tasks,[]);self.assertEqual(len(v.segments),1)
        self.assertEqual(self.api.project_day(self.config,'2026-10-29').segments,[])
    def test_T05_bad_reply_keeps_previous(self):
        self.organize();target=self.home/'task-timeline'/f'{DAY}.json';before=target.read_bytes()
        self.rows.append(row('10:00','10:01'));self.save()
        with self.assertRaises(ValueError):self.organize(dict(tasks=[],assignments=[],progress=[]))
        self.assertEqual(target.read_bytes(),before)
    def test_T11_T12_T13_evidence_and_completion(self):
        p=self.proposal();p['progress'][0].update(kind='ai_reported',completionScope='两个登录场景')
        self.organize(p);v=self.view();self.assertEqual(v.progress[0].kind,'ai_reported');self.assertIsNone(v.progress[0].completionScope)
        stored=self.api.read_tasks(self.home,DAY)
        self.assertIsNone(stored.progress[0].completionScope)
        self.assertNotIn('completionScope',self.api.TaskProposal.model_json_schema()['$defs']['ProposedProgress']['properties'])
        self.assertEqual(v.progress[0].evidence[0].excerpt,'排查登录问题')

    def test_T12_legacy_completion_is_hidden_and_original_file_stays_unchanged(self):
        """历史完成范围和缺字段均兼容读取，派生视图保持停用，原文件保持原字节。"""
        self.organize();path=self.home/'task-timeline'/f'{DAY}.json'
        raw=json.loads(path.read_text())
        for field_present in (True,False):
            with self.subTest(completion_field_present=field_present):
                if field_present:raw['progress'][0]['completionScope']='历史任务已经全部完成'
                else:raw['progress'][0].pop('completionScope',None)
                path.write_text(json.dumps(raw,ensure_ascii=False));before=path.read_bytes()
                self.assertEqual(len(self.api.read_tasks(self.home,DAY).progress),1)
                view=self.view();self.assertEqual(len(view.progress),1)
                self.assertIsNone(view.progress[0].completionScope)
                self.assertEqual(view.progress[0].text,'已定位异常')
                self.assertEqual(path.read_bytes(),before)
    def test_T15_changed_source_invalidates_links(self):
        self.organize();self.rows[0]['analysis']='查阅其他事项';self.save()
        v=self.view();self.assertIsNone(v.segments[0].taskId);self.assertEqual(v.progress,[])
    def test_T10_bad_row_keeps_original_index(self):
        self.rows=[dict(broken=True),row()];self.save();records,issues=self.api.read_activities(self.home,DAY)
        self.assertEqual(len(records),1);self.assertTrue(issues)
        import hashlib
        self.assertEqual(records[0]['id'],hashlib.sha256(f'{DAY}:1:{self.rows[1]["start"]}'.encode()).hexdigest()[:24])
    def test_T27_invalid_reference_rejected(self):
        p=self.proposal();p['assignments'][0]['activityId']='invented'
        with self.assertRaises(ValueError):self.organize(p)
        self.assertFalse((self.home/'task-timeline'/f'{DAY}.json').exists())
    def test_T27_home_lock(self):
        import fcntl
        folder=self.home/'task-timeline';folder.mkdir()
        with (folder/'.organize.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):self.organize()
    def test_T27_cancel_before_commit(self):
        import threading
        event=threading.Event();p=self.proposal()
        def reply():event.set();return json.dumps(p)
        with self.assertRaises(InterruptedError):self.api.organize_day(self.config,DAY,interpreter=Model(reply),cancel_event=event)
        self.assertFalse((self.home/'task-timeline'/f'{DAY}.json').exists())

    def test_T02_two_goals_same_project(self):
        self.rows.append(row('10:00','10:01','设计设置页','Chrome'));self.save();p=self.proposal()
        p['tasks'].append(dict(key='settings',title='设置方案',object='设置页',goal='设计布局'))
        p['assignments'][1]['taskKey']='settings';self.organize(p)
        self.assertEqual(len(self.view().tasks),2)
    def test_T05_input_budget_and_recovery(self):
        model=Model(self.proposal());policy=self.config.taskTimeline.model_copy(update={'maxInputChars':1})
        with self.assertRaises(ValueError):self.api.organize_day(self.config.model_copy(update={'taskTimeline':policy}),DAY,interpreter=model)
        self.assertEqual(model.calls,0);self.organize();self.assertEqual(len(self.view().tasks),1)

    def test_input_budget_selects_complete_oldest_activities_and_keeps_catalog(self):
        """完整目录及证据保留，超预算时按最早活动逐批推进，原文逐字完整。"""
        import yaml
        self.organize();catalog=self.api.read_tasks(self.home,DAY).tasks[0].model_dump()
        self.rows += [row(f'{hour}:00',f'{hour}:01',f'验证登录结果{hour}。'+'原始证据。'*130)
                      for hour in (10,11,12)]
        self.save();original=(self.home/'records'/f'{DAY}.json').read_bytes()
        policy=self.config.taskTimeline.model_copy(update={'maxInputChars':6000})
        config=self.config.model_copy(update={'taskTimeline':policy})
        seen=[];outer=self
        class CheckingModel:
            def run(self,task,patch_path=None):
                patch=yaml.safe_load(patch_path.read_text());text=Path(patch[0]['config']['inputFile']).read_text()
                outer.assertLessEqual(len(text),6000)
                outer.assertGreater(len(text.splitlines()),1,'模型按行读取，输入应保持分行结构')
                outer.assertLess(max(map(len,text.splitlines())),2000)
                payload=json.loads(text);outer.assertEqual(payload['tasks'],[catalog])
                outer.assertIn(len(payload['activities']),(1,2))
                for activity in payload['activities']:
                    seen.append(activity['start'])
                    expected=next(r for r in outer.rows if r['start']==activity['start'])
                    outer.assertEqual(activity['analysis'],expected['analysis'])
                    outer.assertTrue(any(e['activityId']==activity['id'] and e['excerpt']==expected['analysis']
                                         for e in payload['evidenceOptions']))
                return json.dumps(dict(tasks=[],assignments=[dict(activityId=a['id'],taskKey=catalog['taskId'])
                                                            for a in payload['activities']],progress=[]))
        for _ in range(3):self.api.organize_day(config,DAY,interpreter=CheckingModel())
        self.assertEqual(seen,[r['start'] for r in self.rows[1:]])
        self.assertEqual(len(self.api.read_tasks(self.home,DAY).assignments),4)
        self.assertEqual((self.home/'records'/f'{DAY}.json').read_bytes(),original)

    def test_single_activity_over_budget_keeps_tasks_and_skips_model(self):
        """最小完整输入超限明确拒绝，旧任务保留，模型调用为零。"""
        self.organize();target=self.home/'task-timeline'/f'{DAY}.json';before=target.read_bytes()
        self.rows.append(row('10:00','10:01','完整证据'*3000));self.save()
        policy=self.config.taskTimeline.model_copy(update={'maxInputChars':6000});model=Model(self.proposal())
        with self.assertRaisesRegex(ValueError,'最早一条活动'):
            self.api.organize_day(self.config.model_copy(update={'taskTimeline':policy}),DAY,interpreter=model)
        self.assertEqual(model.calls,0);self.assertEqual(target.read_bytes(),before)
    def test_T11_same_progress_merges_evidence(self):
        self.organize();v=self.view();original=v.progress[0]
        self.rows.append(row('14:00','14:01'));self.save();p=self.proposal();tid=v.tasks[0].taskId
        p['tasks']=[];p['assignments']=p['assignments'][-1:];p['assignments'][0]['taskKey']=tid
        records,_=self.api.read_activities(self.home,DAY);r=records[-1]
        p['progress'][0].update(taskKey=tid,progressId=None,evidence=[dict(activityId=r['id'],sourceSignature=r['signature'],excerpt=r['analysis'])])
        self.organize(p);self.assertEqual(len(self.view().progress),1);self.assertEqual(len(self.view().progress[0].evidence),2)
        self.assertEqual(self.view().progress[0].progressId,original.progressId)
    def test_T14_single_activity_has_no_invented_progress(self):
        p=self.proposal();p['progress']=[];self.organize(p)
        self.assertEqual(self.view().progress,[]);self.assertEqual(len(self.view().segments),1)

    def test_T27_unknown_version_preserves_file_and_original_view(self):
        folder=self.home/'task-timeline';folder.mkdir();target=folder/f'{DAY}.json';target.write_text('{"schemaVersion":99}')
        before=target.read_bytes();v=self.view();self.assertTrue(v.issues);self.assertEqual(len(v.segments),1)
        with self.assertRaises(ValueError):self.organize()
        self.assertEqual(target.read_bytes(),before)

    def test_T27_paraphrased_evidence_rejected_and_literal_options_given(self):
        import yaml
        self.rows=[row(text='可见事实：检查登录接口返回401。\n推测：排查登录异常。\n完成状态证据：修复待确认。')];self.save()
        records,_=self.api.read_activities(self.home,DAY);r=records[0]
        proposal=dict(tasks=[dict(key='new',title='排查登录',object='登录接口',goal='排查异常')],assignments=[dict(activityId=r['id'],taskKey='new')],progress=[dict(taskKey='new',text='检查登录报错',kind='observed',completionScope=None,evidence=[dict(activityId=r['id'],sourceSignature=r['signature'],excerpt='登录报错排查')])])
        outer=self
        class CheckingModel:
            def run(self,task,patch_path=None):
                patch=yaml.safe_load(patch_path.read_text());payload=json.loads(Path(patch[0]['config']['inputFile']).read_text())
                outer.assertIn('evidenceOptions',payload,'模型输入需要明确给出逐字引用候选')
                outer.assertTrue(all(e['excerpt'] in r['analysis'] for e in payload['evidenceOptions']))
                return json.dumps(proposal,ensure_ascii=False)
        with self.assertRaisesRegex(ValueError,'进展缺少有效原文证据'):
            self.api.organize_day(self.config,DAY,interpreter=CheckingModel())
        self.assertFalse((self.home/'task-timeline'/f'{DAY}.json').exists())

    def test_B1_large_saved_progress_stays_local_and_new_activities_advance(self):
        """历史进展超过单轮预算后，同目标和新目标活动仍能继续整理。"""
        import yaml
        from scening.task_models import Progress
        self.organize()
        doc=self.api.read_tasks(self.home,DAY);tid=doc.tasks[0].taskId
        previous=doc.progress[0]
        # 使用带合法来源的长进展，模拟真实日文件不断积累后的规模。
        for index in range(48):
            doc.progress.append(Progress(progressId=f'history-{index}',taskId=tid,text=f'历史阶段{index}：'+('已检查登录结果。'*150),kind='observed',completionScope=None,evidence=previous.evidence))
        history=[p.model_dump() for p in doc.progress]
        self.assertGreater(len(json.dumps(history,ensure_ascii=False)),self.config.taskTimeline.maxInputChars)
        self.api.atomic_save(self.home/'task-timeline'/f'{DAY}.json',doc)
        self.rows.extend([row('14:00','14:01','继续验证登录异常','Editor'),row('15:00','15:01','设计音乐播放器的播放列表','Chrome')]);self.save()
        records,_=self.api.read_activities(self.home,DAY);fresh=records[-2:]
        outer=self
        class CheckingModel:
            calls=0
            def run(self,task,patch_path=None):
                self.calls+=1
                patch=yaml.safe_load(patch_path.read_text());source=Path(patch[0]['config']['inputFile'])
                text=source.read_text();payload=json.loads(text)
                outer.assertNotIn('progress',payload)
                outer.assertEqual(payload['tasks'],[t.model_dump() for t in doc.tasks])
                outer.assertEqual([r['id'] for r in payload['activities']],[r['id'] for r in fresh])
                outer.assertTrue(all(e['activityId'] in {r['id'] for r in fresh} for e in payload['evidenceOptions']))
                outer.assertLessEqual(len(text),outer.config.taskTimeline.maxInputChars)
                outer.assertIn('对象与目标一致',task)
                outer.assertIn('创建新任务',task)
                outer.assertIn('本批activities',task)
                return json.dumps(dict(tasks=[dict(key='music',title='设计播放列表',object='音乐播放器',goal='设计播放列表')],assignments=[dict(activityId=fresh[0]['id'],taskKey=tid),dict(activityId=fresh[1]['id'],taskKey='music')],progress=[]),ensure_ascii=False)
        model=CheckingModel();self.api.organize_day(self.config,DAY,interpreter=model)
        after=self.api.read_tasks(self.home,DAY)
        self.assertEqual(model.calls,1)
        self.assertEqual([p.model_dump() for p in after.progress],history)
        links={a.activityId:a.taskId for a in after.assignments}
        self.assertEqual(links[fresh[0]['id']],tid)
        self.assertNotEqual(links[fresh[1]['id']],tid)
        self.assertEqual(len(after.tasks),2)
        self.assertEqual(len(after.assignments),3)

    def test_T27_new_progress_evidence_is_limited_to_current_batch(self):
        """本轮新增进展只引用当前活动，历史来源由本地保存。"""
        self.organize();before=self.api.read_tasks(self.home,DAY)
        self.rows.append(row('14:00','14:01','继续验证登录异常'));self.save()
        records,_=self.api.read_activities(self.home,DAY);old,fresh=records
        proposal=dict(tasks=[],assignments=[dict(activityId=fresh['id'],taskKey=before.tasks[0].taskId)],progress=[dict(taskKey=before.tasks[0].taskId,text='重述历史结果',kind='observed',completionScope=None,evidence=[dict(activityId=old['id'],sourceSignature=old['signature'],excerpt=old['analysis'])])])
        with self.assertRaisesRegex(ValueError,'进展缺少有效原文证据'):
            self.organize(proposal)
        self.assertEqual(self.api.read_tasks(self.home,DAY),before)


class TimelineReplyPendingCountTests(unittest.TestCase):
    def test_pending_count_field_defaults_and_accepts(self):
        """TimelineReadReply新增pendingCount：默认0，旧负载缺字段可解析。"""
        from scening.task_models import TimelineReadReply
        base = dict(day='2026-11-01', sourceRevision='', evidenceRevision='', taskRevision='',
                    organizing='idle', coveredUntil=None, view=None, issues=[])
        legacy = TimelineReadReply.model_validate(base)
        self.assertEqual(legacy.pendingCount, 0)
        self.assertEqual(TimelineReadReply.model_validate({**base, 'pendingCount': 17}).pendingCount, 17)
