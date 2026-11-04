"""类型预设配置边界；全部临时配置位于项目tmp并在结束后清理。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening.observer_config import load_config


class TaskTypePresetTests(unittest.TestCase):
    """验证默认来源、自定义列表和非法值在实际配置入口的结果。"""

    def test_custom_types_and_legacy_config_use_yaml_defaults(self):
        root = Path(__file__).resolve().parents[1]
        defaults = yaml.safe_load((root / 'observer.yaml').read_text())
        with tempfile.TemporaryDirectory(prefix='type-presets-', dir=root / 'tmp') as folder:
            target = Path(folder) / 'observer.json'
            values = dict(defaults, taskTypes=['研究', '个人 学习'])
            target.write_text(json.dumps(values, ensure_ascii=False))
            self.assertEqual(load_config(target).taskTypes, ['研究', '个人 学习'])
            values.pop('taskTypes')
            target.write_text(json.dumps(values, ensure_ascii=False))
            self.assertEqual(load_config(target).taskTypes, defaults['taskTypes'])

    def test_invalid_types_are_rejected(self):
        current = load_config()
        for values in ([], [''], [' '], ['工作', '工作'], [' 工作'], ['工作\n学习'], [42], '工作'):
            with self.subTest(values=values), self.assertRaises(ValueError):
                current.with_overrides(taskTypes=values)

    def test_defaults_are_a_configured_unique_nonempty_list(self):
        current = load_config()
        self.assertEqual(current.taskTypes, ['工作', '学习', '娱乐', '游戏'])
        field = current.model_json_schema()['properties']['taskTypes']
        self.assertEqual(field['minItems'], 1)
        self.assertTrue(field['uniqueItems'])
