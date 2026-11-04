"""多任务记录：真实整理、来源校验、关系文件、时间投影和v1兼容。"""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import yaml

from scening.observer_config import load_config
from scening.task_store import read_activities,read_tasks
from scening.task_timeline import organize_day
from scening.task_time import project_day

DAY='2026-10-30'
class MultiTaskTests(unittest.TestCase):
    def setUp(self):
        """每例独占home，三帧与完整文字都是可追溯的合成来源。"""
        temp=tempfile.TemporaryDirectory(prefix='multi-task-',dir='tmp');self.addCleanup(temp.cleanup)
        self.home=Path(temp.name).resolve();self.config=load_config().with_overrides(home=self.home)
        (self.home/'records').mkdir()
        self.path=self.home/'records'/f'{DAY}.json'
        self.rows=[dict(start=f'{DAY}T09:00:00+08:00',end=f'{DAY}T09:03:00+08:00',app='Editor',
            analysis='第1帧：调整麦克风映射。\n第2帧：测试语音输入。\n第3帧：修改博客段落。',
            screenshot='batch.jpg',mini='batch.jpg',frames=[dict(capturedAt=f'{DAY}T09:0{i}:00+08:00',app=app,screenshot=f'frame{i}.jpg',screen=1) for i,app in enumerate(['无线麦','ZCode','Editor'])])]
        self.path.write_text(json.dumps(self.rows,ensure_ascii=False));self.original=self.path.read_bytes()
    def run_model(self,change=None):
        """仅替换模型返回；输入快照、校验、原子提交、投影均使用正式入口。"""
        outer=self
        class Model:
            def run(self,task,patch_path=None):
                data=yaml.safe_load(patch_path.read_text());payload=json.loads(Path(data[0]['config']['inputFile']).read_text())
                outer.payload=payload;row=payload['activities'][0];options=payload['evidenceOptions']
                ids=[o.get('id',f'e{i+1}') for i,o in enumerate(options)]
                result=dict(schemaVersion=2,newTasks=[dict(key='mic',title='配置麦克风按键',object='麦克风',goal='配置按键'),dict(key='blog',title='修改博客内容',object='博客',goal='修改内容')],assignments=[dict(activityId=row['id'],taskLinks=[dict(taskKey='mic',action='调整按键并测试输入',evidenceIds=ids[:2],progress=[dict(text='调整麦克风映射',kind='observed',evidenceIds=ids[:1])]),dict(taskKey='blog',action='修改文章段落',evidenceIds=ids[2:3],progress=[dict(text='修改博客段落',kind='observed',evidenceIds=ids[2:3])])],unassignedEvidenceIds=[])])
                if change:change(result,payload)
                return json.dumps(result,ensure_ascii=False)
        return organize_day(self.config,DAY,interpreter=Model())
    def test_one_record_two_tasks_owns_progress_and_evidence(self):
        doc=self.run_model();self.assertEqual(doc.schemaVersion,2)
        self.assertEqual(len(doc.assignments),1);self.assertEqual(len(doc.assignments[0].taskLinks),2)
        names={t.taskId:t.title for t in doc.tasks}
        self.assertEqual({names[p.taskId]:[e.excerpt for e in p.evidence] for p in doc.progress},
                         {'配置麦克风按键':['第1帧：调整麦克风映射。'],'修改博客内容':['第3帧：修改博客段落。']})
        self.assertTrue(all('id' in o for o in self.payload['evidenceOptions']))
        self.assertEqual(self.path.read_bytes(),self.original)
        view=project_day(self.config,DAY)
        self.assertEqual(len(view.tasks),2);self.assertEqual(len(view.segments),2)
        self.assertEqual(sum(t.estimatedSeconds for t in view.totals),0)
        self.assertTrue(all(t.hasUncertainCoverage for t in view.totals))
        self.assertTrue(all(s.taskId is None for s in view.slices))
        self.assertEqual({names[p.taskId]:p.evidence[0].frameIndexes for p in doc.progress},
                         {'配置麦克风按键':[1],'修改博客内容':[3]})
    def test_new_batch_keeps_existing_multi_task_record_out_of_unassigned_fillers(self):
        self.run_model()
        self.rows.append({**self.rows[0],'start':f'{DAY}T10:00:00+08:00','end':f'{DAY}T10:03:00+08:00'})
        self.path.write_text(json.dumps(self.rows,ensure_ascii=False))
        self.run_model()
        self.assertEqual(len(self.payload['activities']),1)
        self.assertEqual(self.payload['activities'][0]['start'],self.rows[1]['start'])

    def test_reorganized_branch_keeps_only_progress_supported_by_its_own_evidence(self):
        from scening.task_proposal import compile_proposal
        doc=self.run_model();rows,_=read_activities(self.home,DAY)
        mic=doc.assignments[0].taskLinks[0].taskId
        result=dict(schemaVersion=2,newTasks=[],assignments=[dict(activityId=rows[0]['id'],
            taskLinks=[dict(taskKey=mic,action='测试语音输入',evidenceIds=['e2'],progress=[])],
            unassignedEvidenceIds=['e1','e3'])])
        _,_,progress=compile_proposal(json.dumps(result),rows,doc,DAY,rows)
        self.assertEqual(progress,[])

    def test_precise_frame_timestamp_keeps_same_record_card_and_original_time(self):
        self.rows[0]['end']=f'{DAY}T09:02:00+08:00'
        self.rows[0]['frames'][2]['capturedAt']=f'{DAY}T09:02:00.744349+08:00'
        self.path.write_text(json.dumps(self.rows,ensure_ascii=False));self.run_model()
        view=project_day(self.config,DAY)
        self.assertEqual(len(view.segments),2)
        self.assertEqual(len(view.points),3)
        self.assertEqual(view.points[-1].at,self.rows[0]['frames'][2]['capturedAt'])

    def test_new_task_schema_distinguishes_catalog_and_legacy_reply_keeps_compatibility(self):
        from scening.task_models import MultiTaskProposal
        self.assertIn('newTasks',MultiTaskProposal.model_json_schema()['properties'])
        def old(result,payload):result['tasks']=result.pop('newTasks')
        self.assertEqual(self.run_model(old).schemaVersion,2)

    def test_precise_continuous_part_counts_once_and_keeps_both_branches(self):
        self.run_model();rows,_=read_activities(self.home,DAY);r=rows[0]
        folder=self.home/'activity-evidence';folder.mkdir()
        samples=[dict(sampleId=f's{i}',activityId=r['id'],sourceSignature=r['signature'],
                      capturedAt=f['capturedAt'],runId='run',continuityId='same',sampleSequence=i,
                      app=f['app'],bundleId=None,screen=1) for i,f in enumerate(r['frames'])]
        (folder/f'{DAY}.json').write_text(json.dumps(dict(schemaVersion=1,day=DAY,samples=samples,breaks=[])))
        view=project_day(self.config,DAY);names={t.taskId:t.title for t in view.tasks}
        self.assertEqual({names[t.taskId]:t.estimatedSeconds for t in view.totals},
                         {'配置麦克风按键':60,'修改博客内容':0})
        self.assertEqual(len(view.segments),2)
        self.assertEqual({(s.start,s.end) for s in view.segments},{(self.rows[0]['start'],self.rows[0]['end'])})
        self.assertEqual(sum(s.estimateSeconds for s in view.segments),60)

    def test_empty_links_are_processed_and_keep_unassigned_evidence(self):
        def unresolved(result,payload):
            result['newTasks']=[];record=result['assignments'][0];record['taskLinks']=[]
            record['unassignedEvidenceIds']=[o['id'] for o in payload['evidenceOptions']]
        doc=self.run_model(unresolved)
        self.assertEqual(doc.assignments[0].taskLinks,[])
        self.assertEqual(len(doc.assignments[0].unassignedEvidence),3)
        self.assertEqual(doc.assignments[0].relationVersion,2)
    def test_same_text_with_different_source_kind_stays_separate(self):
        def kinds(result,payload):
            link=result['assignments'][0]['taskLinks'][0]
            link['progress'].append({**link['progress'][0],'kind':'ai_reported'})
        doc=self.run_model(kinds)
        self.assertEqual(len(doc.progress),3)
        self.assertEqual({p.kind for p in doc.progress},{'observed','ai_reported'})
    def test_other_record_evidence_rejected(self):
        self.rows.append({**self.rows[0],'start':f'{DAY}T10:00:00+08:00','end':f'{DAY}T10:03:00+08:00'})
        self.path.write_text(json.dumps(self.rows,ensure_ascii=False))
        def crossed(result,payload):
            import copy
            second=copy.deepcopy(result['assignments'][0]);second['activityId']=payload['activities'][1]['id']
            result['assignments'].append(second)
        with self.assertRaisesRegex(ValueError,'证据编号'):self.run_model(crossed)
        self.assertFalse((self.home/'task-timeline'/f'{DAY}.json').exists())

    def test_current_day_upgrades_legacy_after_new_pending_records(self):
        from datetime import datetime
        from scening.task_models import Assignment,DayTasks,Task
        from scening.task_timeline import pending_rows
        rows=[dict(id='old',signature='signature'),dict(id='new',signature='fresh')]
        assignment=Assignment.model_validate(dict(activityId='old',sourceSignature='signature',taskId='task'))
        doc=DayTasks(day=DAY,generatedAt=self.rows[0]['end'],coveredUntil=None,semanticRevision='',
                     tasks=[Task(taskId='task',day=DAY,title='旧任务',object='对象',goal='目标')],assignments=[assignment],progress=[])
        today=datetime.now().astimezone().date().isoformat()
        self.assertEqual([r['id'] for r in pending_rows(rows,doc,today)],['new','old'])
        self.assertEqual([r['id'] for r in pending_rows(rows,doc,DAY)],['new'])
    def test_failed_v1_backup_preserves_original_and_publishes_no_partial_backup(self):
        rows,_=read_activities(self.home,DAY);r=rows[0]
        folder=self.home/'task-timeline';folder.mkdir()
        legacy=dict(schemaVersion=1,day=DAY,generatedAt=r['end'],coveredUntil=r['end'],semanticRevision='',tasks=[dict(taskId='old',day=DAY,title='旧任务',object='对象',goal='目标')],assignments=[dict(activityId=r['id'],sourceSignature=r['signature'],taskId='old')],progress=[])
        path=folder/f'{DAY}.json';raw=json.dumps(legacy,ensure_ascii=False).encode();path.write_bytes(raw)
        self.rows.append({**self.rows[0],'start':f'{DAY}T10:00:00+08:00','end':f'{DAY}T10:03:00+08:00'})
        self.path.write_text(json.dumps(self.rows,ensure_ascii=False))
        with patch('scening.task_store.os.link',side_effect=OSError('controlled backup failure')):
            with self.assertRaises(OSError):self.run_model()
        self.assertEqual(path.read_bytes(),raw)
        self.assertEqual(list((folder/'backups').iterdir()),[])

    def test_corrupt_stored_link_evidence_is_rejected_without_overwrite(self):
        doc=self.run_model();doc.assignments[0].taskLinks[0].evidence[0].activityId='other-record'
        path=self.home/'task-timeline'/f'{DAY}.json';raw=doc.model_dump_json().encode();path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError,'任务关联证据来源无效'):read_tasks(self.home,DAY)
        self.assertEqual(path.read_bytes(),raw)

    def test_corrupt_quote_degrades_whole_relation_without_claiming_unique_task(self):
        doc=self.run_model();doc.assignments[0].taskLinks[0].evidence[0].excerpt='原文从未出现的内容'
        path=self.home/'task-timeline'/f'{DAY}.json';raw=doc.model_dump_json().encode();path.write_bytes(raw)
        view=project_day(self.config,DAY)
        self.assertEqual(view.tasks,[]);self.assertTrue(view.issues)
        self.assertTrue(all(s.taskId is None for s in view.segments))
        self.assertEqual(path.read_bytes(),raw)

    def test_shared_evidence_is_valid_for_both_task_links(self):
        def shared(result,payload):
            for link in result['assignments'][0]['taskLinks']:
                link['evidenceIds']=[payload['evidenceOptions'][0].get('id','e1')]
                link['progress'][0]['evidenceIds']=link['evidenceIds']
        doc=self.run_model(shared);self.assertEqual(len(doc.progress),2)
        self.assertEqual(doc.progress[0].evidence,doc.progress[1].evidence)
    def test_invalid_reference_preserves_previous_tasks(self):
        self.run_model();path=self.home/'task-timeline'/f'{DAY}.json';before=path.read_bytes()
        self.rows[0]['analysis']+='\n新增可见内容。';self.path.write_text(json.dumps(self.rows,ensure_ascii=False))
        def bad(result,payload):result['assignments'][0]['taskLinks'][0]['progress'][0]['evidenceIds']=['unknown']
        with self.assertRaisesRegex(ValueError,'证据编号'):self.run_model(bad)
        self.assertEqual(path.read_bytes(),before)
    def test_v1_read_upgrade_backups_and_current_source_unchanged(self):
        rows,_=read_activities(self.home,DAY);r=rows[0]
        folder=self.home/'task-timeline';folder.mkdir()
        legacy=dict(schemaVersion=1,day=DAY,generatedAt=r['end'],coveredUntil=r['end'],semanticRevision='',tasks=[dict(taskId='old',day=DAY,title='旧任务名称',object='旧对象',goal='旧目标')],assignments=[dict(activityId=r['id'],sourceSignature=r['signature'],taskId='old')],progress=[])
        path=folder/f'{DAY}.json';raw=json.dumps(legacy,ensure_ascii=False).encode();path.write_bytes(raw)
        self.assertEqual(read_tasks(self.home,DAY).assignments[0].taskLinks[0].taskId,'old')
        self.rows.append({**self.rows[0],'start':f'{DAY}T10:00:00+08:00','end':f'{DAY}T10:03:00+08:00'});self.path.write_text(json.dumps(self.rows,ensure_ascii=False))
        doc=self.run_model();self.assertEqual(doc.schemaVersion,2)
        backups=list((folder/'backups').glob('*.json'));self.assertEqual(len(backups),1);self.assertEqual(backups[0].read_bytes(),raw)
        self.assertEqual(doc.assignments[0].taskLinks[0].taskId,'old')
    def test_ambiguous_frame_uses_record_scope_and_kind_stays_separate(self):
        self.rows[0]['analysis']='可见事实：配置麦克风并修改博客。\n观察到的变化：界面内容发生变化。'
        self.path.write_text(json.dumps(self.rows,ensure_ascii=False))
        def adjust(result,payload):
            links=result['assignments'][0]['taskLinks'];ids=[o.get('id',f'e{i+1}') for i,o in enumerate(payload['evidenceOptions'])]
            for link in links:
                link['evidenceIds']=ids;link['progress'][0]['evidenceIds']=ids[:1]
        doc=self.run_model(adjust);self.assertTrue(all(not e.frameIndexes for p in doc.progress for e in p.evidence))

if __name__=='__main__':unittest.main()
