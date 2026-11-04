"""时间估算：连续样本、空白、多次投入和坏依据。"""
from datetime import datetime,timedelta
import unittest
import test_task_timeline as fixtures
DAY=fixtures.DAY
row=fixtures.row
class TimeTests(unittest.TestCase):
    setUp=fixtures.TaskTests.setUp
    save=fixtures.TaskTests.save
    proposal=fixtures.TaskTests.proposal
    organize=fixtures.TaskTests.organize
    view=fixtures.TaskTests.view
    def samples(self,records):
        from scening.activity_evidence import EvidenceStore
        store=EvidenceStore(self.home)
        seq=0
        for r in records:
            start=datetime.fromisoformat(r['start']);end=datetime.fromisoformat(r['end']);points=[]
            while start<=end:
                seq+=1;points.append(dict(sampleId=f's{seq}',capturedAt=start.isoformat(),runId='run',continuityId='same',sampleSequence=seq,app=r.get('app'),bundleId=None,screen=1))
                start+=timedelta(seconds=60)
            store.append_batch(r,points)
    def test_T06_T07_T21_T22_seventy_minutes_two_segments(self):
        self.rows=[row('09:00','09:40'),row('10:20','10:50','排查登录问题','Editor')];self.save();self.organize()
        records,_=self.api.read_activities(self.home,DAY);self.samples(records);v=self.view()
        self.assertEqual(v.totals[0].estimatedSeconds,4200)
        self.assertEqual(v.totals[0].spanSeconds,6600)
        self.assertEqual(len(v.segments),2)
        self.assertEqual(sum((datetime.fromisoformat(s.end)-datetime.fromisoformat(s.start)).total_seconds() for s in v.slices),6600)
    def test_T08_T24_single_point_and_old_span(self):
        self.rows=[row('09:00','09:00')];self.save();self.organize();v=self.view()
        self.assertEqual(len(v.points),1);self.assertEqual(v.totals[0].estimatedSeconds,0)
        self.rows[0]['end']=f'{DAY}T09:30:00+08:00';self.save();v=self.view()
        self.assertTrue(v.totals[0].hasUncertainCoverage)
        self.assertTrue(all(s.kind=='uncertain' for s in v.slices))
    def test_T23_sequence_gap(self):
        from scening.activity_evidence import EvidenceStore
        self.organize();records,_=self.api.read_activities(self.home,DAY);r=records[0]
        points=[dict(sampleId=f's{i}',capturedAt=r[k],runId='r',continuityId='c',sampleSequence=i,app='Chrome',bundleId=None,screen=1) for i,k in [(1,'start'),(3,'end')]]
        EvidenceStore(self.home).append_batch(r,points)
        self.assertEqual(self.view().totals[0].estimatedSeconds,0)
    def test_T25_corrupt_evidence_is_visible(self):
        self.organize();folder=self.home/'activity-evidence';folder.mkdir();(folder/f'{DAY}.json').write_text('{bad')
        v=self.view();self.assertTrue(v.issues);self.assertEqual(v.totals[0].estimatedSeconds,0)

    def test_T23_overlap_does_not_double_count(self):
        self.rows=[row('09:00','09:01'),row('09:00','09:01','排查登录问题','Editor')];self.save();self.organize()
        records,_=self.api.read_activities(self.home,DAY);self.samples(records)
        self.assertEqual(self.view().totals[0].estimatedSeconds,60)
    def test_T24_empty_day(self):
        self.rows=[];self.save();v=self.view();self.assertEqual(v.segments,[]);self.assertIsNone(v.start)

    def test_T25_one_bad_sample_keeps_other_valid_intervals(self):
        import json
        self.organize();records,_=self.api.read_activities(self.home,DAY);self.samples(records)
        target=self.home/'activity-evidence'/f'{DAY}.json';raw=json.loads(target.read_text());raw['samples'].append(dict(bad='sample'));target.write_text(json.dumps(raw))
        v=self.view();self.assertEqual(v.totals[0].estimatedSeconds,60);self.assertTrue(v.issues)

    def test_T23_ninety_second_boundary(self):
        import json
        from scening.activity_evidence import EvidenceStore
        from datetime import datetime,timedelta
        self.organize();records,_=self.api.read_activities(self.home,DAY);r=records[0]
        for duration,expected in [(90,90),(91,0)]:
            with self.subTest(duration=duration):
                target=self.home/'activity-evidence'/f'{DAY}.json'
                if target.exists():target.unlink()
                self.rows[0]['end']=(datetime.fromisoformat(r['start'])+timedelta(seconds=duration)).isoformat();self.save()
                points=[dict(sampleId=f'p{i}',capturedAt=at,runId='r',continuityId='c',sampleSequence=i,app='Chrome',bundleId=None,screen=1) for i,at in enumerate([r['start'],self.rows[0]['end']])]
                EvidenceStore(self.home).append_batch(r,points)
                self.assertEqual(self.view().totals[0].estimatedSeconds,expected)
    def test_T23_conflicting_tasks_are_uncertain(self):
        self.rows=[row('09:00','09:01'),row('09:00','09:01','编写设置方案')];self.save();p=self.proposal()
        p['tasks'].append(dict(key='other',title='设置方案',object='设置',goal='编写方案'));p['assignments'][1]['taskKey']='other';self.organize(p)
        records,_=self.api.read_activities(self.home,DAY);self.samples(records);v=self.view()
        self.assertEqual(sum(t.estimatedSeconds for t in v.totals),0);self.assertTrue(all(s.kind=='uncertain' for s in v.slices))
