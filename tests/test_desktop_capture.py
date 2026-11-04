"""桌面停止接入：真实采集线程与正式JSON，模型边界采用确定性替身。"""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import observe_activity as activity
from scening import runtime_logging as images
from scening.collector import SensingCollector
from scening.observer_config import load_config
from test_scening import Backend


class DesktopCaptureTests(unittest.TestCase):
    """所有运行文件放在项目tmp独占目录，结束后清理。"""
    def test_stop_during_analysis_stops_production_and_discards_late_result(self):
        """模拟模型调用中收到SIGTERM，检查采集及时停下、旧结果取消且原图保留。"""
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='desktop-stop-', dir=root / 'tmp') as folder:
            home = Path(folder)
            config = load_config().with_overrides(home=home, screenshotDir=home / 'pictures')
            values=config.model_dump()
            values['scening']['observationIntervalSeconds']=.01
            config=config.model_validate(values).with_overrides(sampleIntervalSeconds=.001)
            backend = Backend()
            collectors = []
            def factory(settings, **kwargs):
                """创建真实线程、选图和保存链，仅替换系统取屏。"""
                source = SensingCollector(settings, backend=backend, app_provider=lambda: ('Test', 'test.app'))
                collectors.append(source)
                return source
            case = self
            class Model:
                def analyze(self, image, frames=None):
                    """停止后等真实生产线程退出，再返回当前候选分析结果。"""
                    os.kill(os.getpid(), signal.SIGTERM)
                    source = collectors[0]
                    case.assertTrue(source._stop.is_set())
                    source._thread.join(1)
                    case.assertFalse(source._thread.is_alive())
                    grabs = backend.grabs
                    time.sleep(.05)
                    case.assertEqual(backend.grabs, grabs)
                    return '测试模型结果，当前候选保存完成'
            with patch.object(activity, 'SensingCollector', factory), patch.object(activity, 'KMHInterpreter', return_value=Model()), patch.object(activity.permissions, 'screen_capture_allowed', return_value=True), patch.object(images, 'LOG_PATH', home / 'events.log'):
                self.assertEqual(activity.run_activity(config=config), 0)
            paths = list((home / 'records').glob('*.json'))
            self.assertEqual(paths, [])
            self.assertTrue(list((home / 'pictures').glob('????-??-??/*.jpg')))
            self.assertTrue(list((home / 'analysis').rglob('*.jpg')))
            self.assertIn('cancelled', (home / 'events.log').read_text())
            self.assertTrue(backend.closed)

    def test_desktop_interval_validation(self):
        """桌面间隔沿用唯一配置模型，拒绝零值及非有限数。"""
        settings = load_config()
        for value in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                settings.desktop.model_validate({'refreshIntervalSeconds': value})
        self.assertGreater(settings.desktop.refreshIntervalSeconds, 0)

    def test_capture_only_saves_jpeg_with_zero_model_and_record_calls(self):
        """客户端关闭分析沿用真实仅截图入口，图片落盘与模型边界分别核对。"""
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='desktop-analysis-', dir=root / 'tmp') as folder:
            home = Path(folder)
            config = load_config().with_overrides(home=home, screenshotDir=home / 'pictures', captureCount=1)
            backend = Backend()
            def factory(settings, **kwargs):
                """保留采集线程、候选和正式保存，仅替换系统取屏。"""
                return SensingCollector(settings, backend=backend, app_provider=lambda: ('Test', 'test.app'))
            with patch.object(activity, 'SensingCollector', factory), patch.object(activity, 'KMHInterpreter') as model, patch.object(activity.permissions, 'screen_capture_allowed', return_value=True), patch.object(images, 'LOG_PATH', home / 'events.log'):
                self.assertEqual(activity.run_activity(config=config, capture_only=True), 0)
                model.assert_not_called()
            self.assertTrue(list((home / 'pictures').glob('????-??-??/*.jpg')))
            self.assertFalse((home / 'records').exists())
            self.assertFalse((home / 'summaries').exists())
            self.assertTrue(backend.closed)


if __name__ == '__main__':
    unittest.main()
