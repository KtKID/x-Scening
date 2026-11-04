"""发布路径专项：真实加载YAML，所有用户目录均位于独占tmp。"""
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening.observer_config import load_config


class PublishPathTests(unittest.TestCase):
    """检查配置和显式覆盖实际展开当前用户目录。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.user_home = self.root / 'user'
        self.config = self.root / 'observer.yaml'
        values = load_config().model_dump(mode='json')
        values.update(home='~/.scening', screenshotDir='~/.scening/snapshots', kmhLauncher='~/kmh/scripts/kmh.mjs')
        self.config.write_text(yaml.safe_dump(values))
        environment = patch.dict(os.environ, {'HOME': str(self.user_home)})
        environment.start()
        self.addCleanup(environment.stop)

    def test_config_expands_user_paths_without_creating_data(self):
        before = self.config.read_bytes()
        settings = load_config(self.config)
        self.assertEqual(settings.home, self.user_home / '.scening')
        self.assertEqual(settings.screenshotDir, self.user_home / '.scening/snapshots')
        self.assertEqual(settings.kmhLauncher, self.user_home / 'kmh/scripts/kmh.mjs')
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse(self.user_home.exists())

    def test_explicit_path_override_expands_user_home(self):
        settings = load_config(self.config).with_overrides(home=Path('~/custom'))
        self.assertEqual(settings.home, self.user_home / 'custom')

    def test_publish_log_directory_uses_user_home_in_real_process(self):
        environment = {
            **os.environ,
            'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src'),
            'SCENING_LOG_DIR': '~/publish-logs',
        }
        result = subprocess.run([
            sys.executable, '-B', '-c',
            'from scening.runtime_logging import initialize_logging,log_event; '
            'initialize_logging(); log_event({"stage":"test","result":"saved"})',
        ], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.user_home / 'publish-logs/x-scening.log').is_file())


if __name__ == '__main__':
    unittest.main()
