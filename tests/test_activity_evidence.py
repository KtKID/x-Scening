"""辅助依据保存失败保留前次文件；候选序号由生产端拥有。"""
import importlib,importlib.util,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
class EvidenceTests(unittest.TestCase):
    def test_T25_atomic_failure(self):
        self.assertIsNotNone(importlib.util.find_spec('scening.activity_evidence'),'缺少采样依据保存能力')
        api=importlib.import_module('scening.activity_evidence')
        with tempfile.TemporaryDirectory(dir='tmp') as tmp:
            store=api.EvidenceStore(Path(tmp));store.mark_break('pause','2026-10-30T09:00:00+08:00')
            target=Path(tmp)/'activity-evidence/2026-10-30.json';before=target.read_bytes()
            with patch('scening.task_store.os.replace',side_effect=OSError('fixture write failure')):
                with self.assertRaises(OSError):store.mark_break('pause','2026-10-30T10:00:00+08:00')
            self.assertEqual(target.read_bytes(),before)

    def test_T23_pipeline_saves_samples_after_end_extension(self):
        from datetime import datetime,timedelta,timezone
        from PIL import Image
        from scening.observe_activity import ActivityPipeline
        from scening.frame_store import FrameStore
        from scening.capture import Frame,Display
        from scening.observer_config import load_config
        from scening.activity_evidence import EvidenceStore
        class Model:
            calls=0
            def analyze(self,*args,**kwargs):self.calls+=1;return '正在检查登录结果，完成待确认。'
        with tempfile.TemporaryDirectory(dir='tmp') as tmp:
            home=Path(tmp);config=load_config().with_overrides(home=home,screenshotDir=home/'images');model=Model()
            pipeline=ActivityPipeline(home,model,config);store=FrameStore(config.screenshotDir,config.scening.jpegQuality)
            try:
                start=datetime(2026,10,30,9,tzinfo=timezone(timedelta(hours=8)))
                for i in range(6):
                    at=start+timedelta(seconds=i*60)
                    with Image.new('RGB',(40,40),'green') as image:saved=store.save(Frame(image,at,Display(1,0,0,40,40)),'test',temporary=False)
                    from scening.frame_store import Candidate
                    pipeline.process(Candidate(saved,'test').prepared,at,'Editor','test.editor',screen=1,sample_sequence=i,continuity=0)
                evidence=EvidenceStore(home).read('2026-10-30')
                self.assertEqual(len(evidence.samples),6);self.assertEqual([s.sampleSequence for s in evidence.samples],list(range(6)))
                self.assertEqual(len({s.activityId for s in evidence.samples}),1);self.assertEqual(model.calls,1)
            finally:store.close()
