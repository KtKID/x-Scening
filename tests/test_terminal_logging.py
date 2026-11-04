"""用实际文件和stdout管道验证终端进度，采集/模型替身限定在外部边界。"""
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from scening import observe_activity as activity
# 复用真实入口持有的日志模块，保持全量发现时与旧测试的动态导入隔离。
images=activity.runtime_logging

from scening_fixtures import PreparedSource
from scening.observer_config import load_config

class TerminalLoggingTests(unittest.TestCase):
    def setUp(self):
        source_patch = patch.object(activity, 'SensingCollector', PreparedSource)
        source_patch.start()
        self.addCleanup(source_patch.stop)
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / "tmp")
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.home=self.root/'home'
        self.config=load_config().with_overrides(home=self.home,screenshotDir=self.home/'pictures')
        self.log=self.root/'logs/events.log'
        setting=patch.object(images,'LOG_PATH',self.log)
        setting.start()
        self.addCleanup(setting.stop)
        images.initialize_logging()

    def test_t1_pipe_receives_saved_paths_while_process_is_busy(self):
        """stdout连接管道时，仍在运行的子进程立即输出时间和JPEG 路径。"""
        scripts=str(Path(images.__file__).parent.parent)
        code=('import sys,time\nfrom pathlib import Path\n'
              f'sys.path.insert(0,{scripts!r})\nfrom scening import runtime_logging as image\n'
              'image.LOG_PATH=Path(sys.argv[1])\nimage.initialize_logging()\n'
              'image.log_event({"stage":"image_prepare","result":"saved","screenshot":"original.jpg","mini":"original.jpg"})\n'
              'time.sleep(5)\n')
        child=subprocess.Popen([sys.executable,'-B','-c',code,str(self.log)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout,selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=1.5),'子进程忙碌时stdout尚未显示日志')
            first=child.stdout.readline()
            self.assertIsNone(child.poll())
            event=json.loads(self.log.read_text().splitlines()[-1])
            self.assertIn(event['time'],first)
            self.assertIn('original.jpg',first)
        finally:
            if child.poll() is None:
                child.terminate()
            child.communicate(timeout=3)

    def test_t2_round_progress_and_dedup_keep_real_images_and_records(self):
        """两批六帧真实JPEG保存、待凑提示、先分析后模型、重复批只延长均可见。"""
        output=io.StringIO()
        calls=[]
        check=self
        class Model:
            def analyze(self, mini, frames=None):
                calls.append(mini)
                check.assertIn('KMH 分析中',output.getvalue())
                check.assertIn(str(mini),output.getvalue())
                return 'PRIVATE_MODEL_BODY'
        with redirect_stdout(output), patch.object(activity.permissions,'screen_capture_allowed',return_value=True), patch.object(activity,'frontmost_application',return_value=('Browser','browser')), patch.object(activity,'KMHInterpreter',return_value=Model()):
            self.assertEqual(activity.run_activity(config=self.config,interval=.001,count=6),0)
        entries=[json.loads(line) for line in self.log.read_text().splitlines()]
        saved=[item for item in entries if item['stage']=='image_prepare' and item['result']=='saved']
        self.assertEqual(len(saved),6,entries)
        text=output.getvalue()
        for event in saved:
            self.assertIn(event['time'],text)
            for key in ['screenshot','mini']:
                self.assertTrue(Path(event[key]).exists())
                self.assertIn(event[key],text)
        self.assertEqual(len(calls),1)
        self.assertIn('画面相同',text)
        self.assertIn('记录已保存',text)
        self.assertIn(str(self.home/'records'),text)
        self.assertNotIn('PRIVATE_MODEL_BODY',text)
        records=list((self.home/'records').glob('*.json'))
        self.assertEqual(len(json.loads(records[0].read_text())),1)
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))),6)
        self.assertIn('分析待凑图：1/3',text)

    def test_t3_file_failure_and_summary_progress(self):
        """文件日志失败保持异常；总结调用前已有提示，正文保持在结果文件。"""
        output=io.StringIO()
        blocked=self.root/'blocked'
        blocked.write_text('file')
        with redirect_stdout(output),patch.object(images,'LOG_PATH',blocked/'log'):
            with self.assertRaises(OSError):
                images.log_event({'stage':'image_prepare','result':'saved','screenshot':'/tmp/raw.png','mini':'/tmp/raw_mini.png'})
        self.assertEqual(output.getvalue(),'')
        at=datetime(2026,10,19,12,tzinfo=timezone(timedelta(hours=8)))
        check=self
        class Model:
            def summarize(self,snapshot):
                check.assertIn('总结生成中',output.getvalue())
                return 'PRIVATE_SUMMARY_BODY'
        pipeline=activity.ActivityPipeline(self.home,Model(),config=self.config)
        pipeline.memory.append({'start':at.isoformat(),'end':at.isoformat(),'app':'Browser','bundleId':'browser','analysis':'页面','source':'screen','screenshot':'screenshot/raw.png','mini':'screenshot/raw_mini.png'})
        with redirect_stdout(output):
            self.assertEqual(pipeline.summarize(at,at+timedelta(seconds=1),'manual_exit'),'saved')
        self.assertIn('总结已保存',output.getvalue())
        self.assertIn(str(self.home/'summaries/2026-10-19.json'),output.getvalue())
        self.assertNotIn('PRIVATE_SUMMARY_BODY',output.getvalue())

if __name__=='__main__':
    unittest.main()
