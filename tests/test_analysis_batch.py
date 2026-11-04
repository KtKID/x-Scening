"""三帧批分析专项；系统取屏与模型边界受控，JPEG、协议和JSON走真实实现。"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import observe_activity as activity
from scening import runtime_logging
from scening.activity_memory import ActivityEvent
from scening.capture import Display, Frame
from scening.frame_store import Candidate, FrameStore
from scening.kmh_interpreter import KMHInterpreter
from scening.observer_config import load_config
from scening_fixtures import PreparedSource

AT = datetime(2026, 10, 28, 12, tzinfo=timezone(timedelta(hours=8)))


class Model:
    """只替换外部模型，检查收到的是已经完整保存的图片。"""
    def __init__(self):
        self.calls = []

    def analyze(self, image, frames=None):
        with Image.open(image) as saved:
            saved.load()
        self.calls.append((Path(image), frames))
        return '可见活动：检查项目。意图推测：验证配置。当前阶段与完成证据：完成状态待确认。'


class AnalysisBatchTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        (root / 'tmp').mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='analysis-batch-', dir=root / 'tmp')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / 'home'
        self.config = load_config().with_overrides(home=self.home, screenshotDir=Path(self.temporary.name) / 'pictures')
        self.log = Path(self.temporary.name) / 'events.log'
        logging = patch.object(runtime_logging, 'LOG_PATH', self.log)
        logging.start()
        self.addCleanup(logging.stop)
        self.model = Model()
        self.pipeline = activity.ActivityPipeline(self.home, self.model, self.config)
        self.store = FrameStore(self.config.screenshotDir, self.config.scening.jpegQuality)
        self.addCleanup(self.store.close)

    def frame(self, at, color='black', size=(2560, 1440)):
        """只准备一张真实候选；测试动作及期待顺序由各测试正文负责。"""
        with Image.new('RGB', size, color) as image:
            saved = self.store.save(Frame(image, at, Display(1, 0, 0, *size)), 'test', temporary=False)
        return Candidate(saved, 'test').prepared

    def rows(self, day='2026-10-28'):
        return json.loads((self.home / 'records' / (day + '.json')).read_text())

    def test_t01_waits_for_three_and_preserves_order_times_and_sources(self):
        """一、二帧保持待凑；第三帧只调用一次，真实拼图及三帧引用可回查。"""
        inputs=[]
        for index, (seconds, color) in enumerate([(0, 'red'), (20, 'green'), (320, 'blue')]):
            at=AT+timedelta(seconds=seconds)
            frame=self.frame(at,color)
            inputs.append(frame.original)
            result=self.pipeline.process(frame,at,'Editor','editor',screen=1)
            self.assertEqual(result, 'pending' if index<2 else 'analyzed')
            self.assertEqual(len(self.model.calls), 0 if index<2 else 1)
        record=self.rows()[0]
        self.assertEqual((record['start'],record['end']),(AT.isoformat(),(AT+timedelta(seconds=320)).isoformat()))
        self.assertEqual([item['screenshot'] for item in record['frames']],[str(p) for p in inputs])
        self.assertEqual(record['screenshot'],record['mini'])
        collage=self.home/record['screenshot']
        with Image.open(collage) as image:
            self.assertEqual(image.size,(1440,2538))
            for y,color in [(100,(255,0,0)),(946,(0,128,0)),(1792,(0,0,255))]:
                actual=image.getpixel((100,y))
                self.assertTrue(all(abs(a-b)<8 for a,b in zip(actual,color)))
        self.assertEqual(self.model.calls[0][1][-1]['gapSeconds'],300)
        self.assertTrue(all(p.is_file() for p in inputs))

    def test_t02_all_frames_must_match_for_end_extension(self):
        """重复批只延长；中间白帧即使末帧恢复黑色仍分析一次。"""
        for index in range(3):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        before=self.rows()[0]
        for index in range(3,6):
            at=AT+timedelta(seconds=index)
            result=self.pipeline.process(self.frame(at),at,'Editor','editor')
        expected=dict(before,end=(AT+timedelta(seconds=5)).isoformat())
        self.assertEqual(self.rows(),[expected])
        self.assertEqual(len(self.model.calls),1)
        for index,color in [(6,'black'),(7,'white'),(8,'black')]:
            at=AT+timedelta(seconds=index)
            result=self.pipeline.process(self.frame(at,color),at,'Editor','editor')
        self.assertEqual(result,'analyzed')
        self.assertEqual(len(self.model.calls),2)
        self.assertEqual(len(self.rows()),2)

    def test_t03_mixed_apps_keep_per_frame_identity(self):
        for index,name in enumerate(['Browser','Editor','Terminal']):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,name,name.lower(),screen=index+1)
        row=self.rows()[0]
        self.assertEqual(row['app'],'Browser、Editor、Terminal')
        self.assertIsNone(row['bundleId'])
        self.assertEqual([f['app'] for f in row['frames']],['Browser','Editor','Terminal'])
        self.assertEqual([f['screen'] for f in row['frames']],[1,2,3])

    def test_t04_cross_day_starts_a_new_batch(self):
        last=AT.replace(hour=23,minute=59,second=58)
        for index in range(5):
            at=last+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        self.assertFalse((self.home/'records/2026-10-28.json').exists())
        self.assertEqual(len(self.model.calls),1)
        row=self.rows('2026-10-29')[0]
        self.assertEqual(row['start'],'2026-10-29T00:00:00+08:00')
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))),5)

    def test_t05_interrupt_and_exit_keep_partial_images_without_analysis(self):
        for index in range(2):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        self.pipeline.reset('采集中断')
        for index in range(2,4):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        self.pipeline.discard_pending('退出')
        self.assertEqual(self.model.calls,[])
        self.assertFalse((self.home/'records').exists())
        entries=[json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([e['pendingCount'] for e in entries if e['result']=='incomplete'],[2,2])
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))),4)

    def test_t06_collage_failure_stops_model_and_preserves_raw_files(self):
        for index in range(2):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        at=AT+timedelta(seconds=2)
        frame=self.frame(at)
        with patch('scening.analysis_batch.commit_exclusive',side_effect=OSError('拼图写入失败')):
            with self.assertRaisesRegex(OSError,'拼图写入失败'):
                self.pipeline.process(frame,at,'Editor','editor')
        self.assertEqual(self.model.calls,[])
        self.assertFalse((self.home/'records').exists())
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))),3)

    def test_t07_record_failure_clears_anchor_and_next_batch_recovers(self):
        for index in range(2):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        at=AT+timedelta(seconds=2)
        with patch.object(self.pipeline.memory,'append',side_effect=OSError('记录保存失败')):
            with self.assertRaisesRegex(OSError,'记录保存失败'):
                self.pipeline.process(self.frame(at),at,'Editor','editor')
        for index in range(3,6):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        self.assertEqual(len(self.model.calls),2)
        self.assertEqual(len(self.rows()),1)
        self.assertEqual(len(list((self.home/'analysis').rglob('*.jpg'))),2)

    def test_t08_kmh_prompt_has_temporal_metadata_and_intent_focus(self):
        engine=KMHInterpreter(self.home,config=self.config.with_overrides(kmhProfile='scene_observer'),command=[sys.executable,'-c','import sys,json;print(json.dumps(sys.argv[1]))'])
        frames=[{'capturedAt':AT.isoformat(),'app':'Editor','bundleId':'editor','screen':1,'gapSeconds':None}]
        prompt=json.loads(engine.analyze(self.home/'batch.jpg',frames=frames))
        self.assertIn('read_image',prompt)
        self.assertIn(AT.isoformat(),prompt)
        self.assertIn('意图',prompt)
        self.assertIn('可见操作与变化',prompt)
        self.assertIn('任务整体完成判断已停用',prompt)
        self.assertIn('gapSeconds',prompt)

    def test_t09_nested_frame_paths_follow_memory_boundary(self):
        for index in range(3):
            at=AT+timedelta(seconds=index)
            self.pipeline.process(self.frame(at),at,'Editor','editor')
        row=self.rows()[0]
        invalid=json.loads(json.dumps(row));invalid['frames'][0]['screenshot']='../escape.jpg'
        with self.assertRaises(ValueError):
            ActivityEvent.model_validate(invalid,context=self.pipeline.memory.validation_context)
        invalid=json.loads(json.dumps(row));invalid['frames'][0]['screenshot']='/outside/frame.jpg'
        with self.assertRaises(ValueError):
            self.pipeline.memory.append(invalid)

    def test_t10_real_control_loop_keeps_partial_batch_on_exit(self):
        with patch.object(activity,'SensingCollector',PreparedSource), patch.object(activity.permissions,'screen_capture_allowed',return_value=True), patch.object(activity,'frontmost_application',return_value=('Editor','editor')), patch.object(activity,'KMHInterpreter',return_value=self.model):
            self.assertEqual(activity.run_activity(config=self.config,interval=.001,count=2),0)
        self.assertEqual(self.model.calls,[])
        self.assertFalse((self.home/'records').exists())
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))),2)
        self.assertTrue(any(json.loads(line).get('result')=='incomplete' for line in self.log.read_text().splitlines()))

    def test_t11_generation_change_discards_pending_batch(self):
        candidates=[]
        for index,generation in enumerate([0,0,1,1,1]):
            at=AT+timedelta(seconds=index)
            with Image.new('RGB',(200,100),'black') as image:
                saved=self.store.save(Frame(image,at,Display(1,0,0,200,100),'Editor','editor'),'test',temporary=False)
            candidates.append(Candidate(saved,'test',generation))
        class Source(PreparedSource):
            def next_candidate(self,timeout=None):
                return candidates.pop(0)
        with patch.object(activity,'SensingCollector',Source),patch.object(activity.permissions,'screen_capture_allowed',return_value=True),patch.object(activity,'KMHInterpreter',return_value=self.model):
            self.assertEqual(activity.run_activity(config=self.config,interval=.001,count=5),0)
        self.assertEqual(len(self.model.calls),1)
        self.assertEqual(self.rows()[0]['start'],(AT+timedelta(seconds=2)).isoformat())

    def test_t12_batch_config_is_strict_and_geometry_is_bounded(self):
        self.assertEqual(self.config.analysis.batchSize,3)
        for key,value in [('batchSize',1),('batchSize',4),('batchSize',True),('frameMaxWidth',0),('jpegQuality',96),('labelHeight',1),('labelFontSize',37),('maxImagePixels',1)]:
            values=self.config.model_dump();values['analysis'][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):
                self.config.model_validate(values)


if __name__=='__main__':
    unittest.main()
