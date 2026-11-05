"""模型设置透传测试；子进程与文件在独占tmp，模型返回使用本地替身。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from scening.kmh_interpreter import KMHInterpreter
from scening.observer_config import load_config


class ModelPatchTests(unittest.TestCase):
    """覆盖模型补丁选择、每次重读和专用工具补丁顺序。"""
    def test_model_patch_precedes_tool_patch_and_is_checked_each_call(self):
        """保存模型后下一轮读取模型补丁，单次工具配置继续后置。"""
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=root/'tmp',prefix='model-patch-') as folder:
            home=Path(folder);(home/'kmh').mkdir()
            model=home/'kmh/observer-model.patch.yml';model.write_text('[]')
            tool=home/'tool.yml';tool.write_text('[]')
            script=home/'args.py'
            script.write_text('import json,sys;print(json.dumps(sys.argv[1:]))')
            runner=KMHInterpreter(home,config=load_config(),command=[sys.executable,str(script)])
            arguments=json.loads(runner.run('task',patch_path=tool))
            self.assertEqual(arguments,['--patch',str(model),'--patch',str(tool),'task'])
            model.unlink()
            self.assertEqual(json.loads(runner.run('next')),['next'])

    def test_bundled_node_and_launcher_override_external_locations(self):
        """桌面资源环境提供内置Node与启动器，调用外形沿用dsh/scening。"""
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=root/'tmp',prefix='bundled-kmh-') as folder:
            home=Path(folder);launcher=home/'kmh.py'
            launcher.write_text('import json,sys;print(json.dumps(sys.argv[1:]))')
            config=load_config().with_overrides(kmhLauncher=home/'missing.mjs')
            with patch.dict('os.environ',{'SCENING_KMH_NODE':sys.executable,'SCENING_KMH_LAUNCHER':str(launcher)}):
                runner=KMHInterpreter(home,config=config)
                self.assertEqual(json.loads(runner.run('task')),['dsh','--profile','scening','task'])
