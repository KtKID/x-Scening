"""scening接入契约：真实KMHInterpreter子进程、临时运行配置、JSON与批次存储。"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from PIL import Image
from pydantic import BaseModel

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from scening.kmh_interpreter import KMHInterpreter
from scening.observation_generated import ObservationResult
from scening.observer_config import load_config
from scening.observe_activity import ActivityPipeline
from scening import runtime_logging
from scening.runtime_control import AnalysisCancelled
from scening.capture import Display, Frame
from scening.frame_store import FrameStore, Candidate


RESULT={'schema_version':1,'visible_activity':'正在调试观察工具','inferred_intent':'推测在验证图片分析接入',
        'stage_and_evidence':'画面显示测试输出，最终完成状态待确认','app_tags':['Observer','Chrome'],
        'task_types':['研究','写作']}


class SceningProfileTests(unittest.TestCase):
    """所有模型替身和数据在项目tmp，真实KMH子进程/回收边界保持。"""
    def setUp(self):
        root=Path(__file__).resolve().parents[1]
        temporary=tempfile.TemporaryDirectory(prefix='scening-profile-',dir=root/'tmp')
        self.addCleanup(temporary.cleanup)
        self.home=Path(temporary.name)
        self.config=load_config().with_overrides(home=self.home,screenshotDir=self.home/'pictures',kmhProfile='scening',taskTypes=['研究','写作'])
        self.image=self.home/'input.jpg'
        with Image.new('RGB',(120,60),'blue') as image:
            image.save(self.image,'JPEG')
        self.before=self.image.read_bytes()
        self.launcher=self.home/'launcher.py'
        self.launcher.write_text('''import json,pathlib,sys,time,yaml
home=pathlib.Path(__file__).parent
case=sys.argv[1]
if '--patch' not in sys.argv:
 (home/'request.json').write_text(json.dumps({'args':sys.argv,'config':None}))
 print('legacy-response')
 raise SystemExit(0)
patch=pathlib.Path(sys.argv[sys.argv.index('--patch')+1])
config=yaml.safe_load(patch.read_text())[0]['config']
(home/'request.json').write_text(json.dumps({'args':sys.argv,'config':config,'task':sys.argv[-1]}))
if case=='block':
 (home/'ready').write_text('ready')
 time.sleep(30)
if config['mode']=='summary':
 print('' if case=='empty' else '专用总结正文')
 raise SystemExit(0)
data='''+repr(RESULT)+'''
if case=='missing': raise SystemExit(0)
if case=='version': data['schema_version']=2
if case=='blank': data['visible_activity']='   '
if case=='type': data['visible_activity']=42
if case=='tags': data['app_tags']=['']
if case=='legacy': data.pop('task_types')
if case=='empty_types': data['task_types']=[]
if case=='unknown_types': data['task_types']=['额外类型']
if case=='blank_types': data['task_types']=[' ']
if case=='scalar_types': data['task_types']='研究'
if case=='extra': data['unexpected']=True
pathlib.Path(config['resultFile']).write_text('{' if case=='broken' else json.dumps(data))
raise SystemExit(7 if case=='failure' else 0)
''')

    def interpreter(self,case='valid'):
        """仅替换KMH模型任务，运行参数与生命周期使用实际解释器。"""
        return KMHInterpreter(self.home,config=self.config,command=[sys.executable,str(self.launcher),case])

    def test_analysis_accepts_empty_stdout_and_reads_structured_result(self):
        """专用工具成功提交JSON且stdout为空时，接收内容、标签和采样上下文。"""
        self.config=self.config.with_overrides(taskTypes=['研究','写作'])
        frames=[{'capturedAt':'2026-10-28T20:09:00+08:00','frame':1,'gapSeconds':None,'app':'Observer','screen':1}]
        result=self.interpreter().analyze(self.image,frames=frames)
        self.assertIsInstance(result,BaseModel)
        self.assertEqual(result.model_dump(),RESULT)
        request=json.loads((self.home/'request.json').read_text())
        self.assertEqual(request['config']['mode'],'analysis')
        self.assertEqual(request['config']['inputFile'],str(self.image.resolve()))
        self.assertTrue(Path(request['config']['resultFile']).is_absolute())
        self.assertIn('submit_observation',request['task'])
        self.assertIn(frames[0]['capturedAt'],request['task'])
        self.assertIn(json.dumps(['研究','写作'],ensure_ascii=False),request['task'])
        self.assertIn('submit_observation的task_types',request['task'])
        self.assertIn('任务整体完成判断已停用',request['task'])
        self.assertIn('可见操作与变化',request['task'])
        self.assertEqual(list((self.home/'kmh').glob('scening-call-*')),[])
        self.assertEqual(self.image.read_bytes(),self.before)

    def test_missing_invalid_and_failed_results_are_rejected(self):
        """缺结果、坏JSON、错误版本/字段/标签及非零退出都保持失败并清理临时文件。"""
        for case in ('missing','broken','version','blank','type','tags','extra','failure',
                     'unknown_types','blank_types','scalar_types'):
            with self.subTest(case=case):
                with self.assertRaises(RuntimeError):
                    self.interpreter(case).analyze(self.image)
                self.assertEqual(list((self.home/'kmh').glob('scening-call-*')),[])
                self.assertEqual(self.image.read_bytes(),self.before)

    def test_task_types_empty_and_legacy_results_remain_readable(self):
        """空类型表示证据不足；旧结果缺项补独立空列表，历史输入保持原值。"""
        for case in ('empty_types','legacy'):
            with self.subTest(case=case):
                self.assertEqual(self.interpreter(case).analyze(self.image).task_types,[])
        legacy={key:value for key,value in RESULT.items() if key!='task_types'}
        first=ObservationResult.model_validate(legacy)
        second=ObservationResult.model_validate(legacy)
        first.task_types.append('研究')
        self.assertEqual(second.task_types,[])
        self.assertNotIn('task_types',legacy)

    def test_summary_uses_dedicated_mode_and_stdout(self):
        """总结配置仅提供本轮JSON，正文仍由stdout返回，空正文失败。"""
        snapshot=self.home/'window.json';snapshot.write_text('{}')
        self.assertEqual(self.interpreter().summarize(snapshot),'专用总结正文')
        request=json.loads((self.home/'request.json').read_text())
        self.assertEqual(request['config'],{'mode':'summary','inputFile':str(snapshot.resolve())})
        with self.assertRaises(RuntimeError):
            self.interpreter('empty').summarize(snapshot)

    def test_pipeline_preserves_observation_and_compatible_display_text(self):
        """真实三帧批次保存完整工具结果及现有卡片文字，保留三张原图证据。"""
        pipeline=ActivityPipeline(self.home,self.interpreter(),config=self.config)
        at=datetime(2026,10,28,20,9,tzinfo=timezone(timedelta(hours=8)))
        store=FrameStore(self.config.screenshotDir,self.config.scening.jpegQuality)
        self.addCleanup(store.close)
        with patch.object(runtime_logging,'LOG_PATH',self.home/'events.log'):
            for index in range(3):
                when=at+timedelta(seconds=index)
                with Image.new('RGB',(120,60),'blue') as image:
                    saved=store.save(Frame(image,when,Display(1,0,0,120,60),'Observer','observer'),'periodic',temporary=False)
                pipeline.process(Candidate(saved,'periodic').prepared,when,'Observer','observer',screen=1)
        row=json.loads((self.home/'records/2026-10-28.json').read_text())[0]
        self.assertIn('observation',row)
        self.assertEqual(row['observation'],RESULT)
        self.assertIn('可见事实：'+RESULT['visible_activity'],row['analysis'])
        self.assertIn(RESULT['inferred_intent'],row['analysis'])
        self.assertIn('观察到的变化：'+RESULT['stage_and_evidence'],row['analysis'])
        self.assertNotIn('完成状态证据：',row['analysis'])
        self.assertEqual(len(row['frames']),3)

    def test_cancel_cleans_call_files_and_preserves_image(self):
        """专用任务执行中取消，模型进程回收后临时配置/结果清理，原图保留。"""
        engine=self.interpreter('block')
        errors=[]
        def run():
            try: engine.analyze(self.image)
            except BaseException as error: errors.append(error)
        worker=threading.Thread(target=run)
        worker.start()
        try:
            deadline=time.monotonic()+3
            while not (self.home/'ready').exists():
                if time.monotonic()>deadline:
                    self.fail('专用调用未启动')
                time.sleep(.01)
            engine.cancel(timeout=.8)
        finally:
            engine.cancel(timeout=.8)
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors),1)
        self.assertIsInstance(errors[0],AnalysisCancelled)
        self.assertEqual(list((self.home/'kmh').glob('scening-call-*')),[])
        self.assertEqual(self.image.read_bytes(),self.before)


if __name__=='__main__':
    unittest.main()
