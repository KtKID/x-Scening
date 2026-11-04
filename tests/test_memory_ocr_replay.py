"""从真实MSS/Vision阶段日志导出的夹具回放，文件提交与目录检查执行生产代码。"""
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from scening.capture import Display
from scening.collector import SensingCollector
from scening.observer_config import load_config

FIXTURES = Path(__file__).parent/'fixtures/memory_ocr_native'
# 预期依据本轮用户要求与Spec场景10手写，独立于真实运行产生的observed结果。
EXPECTED = {
    'allowed': {'blocked': False, 'reason': 'clean', 'hits': [], 'beforeJpegs': 0,
                'afterJpegs': 1, 'afterMetadata': 1, 'candidates': 1},
    'sensitive': {'blocked': True, 'reason': 'content', 'hits': ['openai-key'], 'beforeJpegs': 0,
                  'afterJpegs': 0, 'afterMetadata': 0, 'candidates': 0},
}


class RecordedBackend:
    """只替换系统取帧与状态边界，返回真实录制PNG中的原始像素。"""
    def __init__(self, record):
        self.record = record
        self.display = Display(**record['input']['display'])

    def displays(self):
        return [self.display]

    def grab(self, display):
        assert display == self.display
        with Image.open(FIXTURES/self.record['input']['image']) as image:
            return image.convert('RGB')

    def pointer(self):
        return self.display.left+1, self.display.top+1

    def idle_seconds(self):
        return 0

    def display_asleep(self):
        return False

    def close(self):
        pass


class NativeOCRReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.recording = json.loads((FIXTURES/'recording.json').read_text())

    def replay(self, case_id, lines=None):
        """回放录制像素/OCR行，实际执行选图、敏感规则、提交与索引，并核对手写预期。"""
        record = next(c for c in self.recording['cases'] if c['id'] == case_id)
        expected = EXPECTED[case_id]
        self.assertEqual(record['expected'], expected)
        self.assertEqual(record['observed'], expected)
        with tempfile.TemporaryDirectory(prefix='native-ocr-replay-', dir='tmp') as directory:
            root = Path(directory)
            config = load_config().with_overrides(home=root/'home', screenshotDir=root/'shots',
                     privacy=self.recording['config']['privacy'], scening=self.recording['config']['scening'])
            collector = SensingCollector(config, backend=RecordedBackend(record), clock=lambda: 0,
                        wall_clock=lambda: datetime.fromisoformat(record['input']['capturedAt']),
                        app_provider=lambda *_: (record['input']['app'], record['input']['bundleId']))
            def ocr(source):
                self.assertIsInstance(source, bytes)
                self.assertEqual(hashlib.sha256(source).hexdigest(), record['jpegSha256'])
                self.assertEqual(len(list(config.screenshotDir.rglob('*.jpg'))), expected['beforeJpegs'])
                return record['ocrLines'] if lines is None else lines
            try:
                with patch('scening.sensitive_guard.ocr_lines', side_effect=ocr) as mock_ocr:
                    collector.tick(0)
                self.assertEqual(mock_ocr.call_count, 1)
                self.assertEqual(len(list(config.screenshotDir.rglob('*.jpg'))), expected['afterJpegs'])
                self.assertEqual(len(list(config.screenshotDir.rglob('*.metadata.json'))), expected['afterMetadata'])
                self.assertEqual(collector.candidates.qsize(), expected['candidates'])
                if expected['afterJpegs']:
                    candidate = collector.next_candidate(timeout=0)
                    self.assertEqual(hashlib.sha256(candidate.saved.path.read_bytes()).hexdigest(), record['jpegSha256'])
                else:
                    status = [s for s in collector.drain_status() if s.get('result') == 'privacy_blocked']
                    self.assertEqual(status[0]['reason'], expected['reason'])
                    self.assertEqual(status[0]['hits'], expected['hits'])
            finally:
                collector.close()

    def test_recorded_allow_saves_only_after_ocr(self):
        """测试内容：回放真实普通页截图及真实Vision返回。

        期望结果：进入OCR时截图目录JPEG数量为零；通过后正式JPEG、metadata与候选各1，
        正式JPEG的哈希与真实录制时受检字节一致，实际文件操作保持真实。
        """
        self.replay('allowed')

    def test_recorded_sensitive_leaves_zero_files(self):
        """测试内容：回放真实合成密钥页截图及真实Vision返回。

        期望结果：既有规则真实命中openai-key，判定前后JPEG及metadata数量均为零，候选为零。
        """
        self.replay('sensitive')

    def test_fixture_images_and_origin_match_recording(self):
        """测试内容：核对夹具来源、手写预期及两张真实采集图的哈希与尺寸。

        期望结果：来源标记为真实MSS/Vision；两图SHA256及尺寸吻合，预期符合独立场景契约。
        """
        self.assertEqual(self.recording['schemaVersion'], 1)
        self.assertEqual(self.recording['source']['kind'], 'native-mss-real-vision-controlled-page')
        for record in self.recording['cases']:
            with self.subTest(case=record['id']):
                path = FIXTURES/record['input']['image']
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), record['input']['sha256'])
                with Image.open(path) as image:
                    self.assertEqual(image.size, (record['input']['display']['width'],record['input']['display']['height']))
                self.assertEqual(record['expected'], EXPECTED[record['id']])

    def test_changed_ocr_fails_original_allow_expectation(self):
        """测试内容：将允许样本的OCR返回故意改成合成密钥，保留原始允许预期。

        期望结果：真实敏感规则导致保存数量断言失败，证明手写预期能发现行为变化。
        """
        with self.assertRaises(AssertionError):
            self.replay('allowed', lines=['sk-proj-demo'])

    def test_stage_log_exports_the_same_replay_fixture(self):
        """测试内容：从随夹具保存的真实阶段JSONL重新导出到独占临时目录。

        期望结果：导出数据与固定夹具完全一致，OCR原始分词、配置、采集哈希及手写预期保持；
        测试仅使用夹具目录，导出器真实解析日志并生成文件。
        """
        path = Path(__file__).resolve().parents[1]/'scripts/verify_memory_ocr_e2e.py'
        spec = importlib.util.spec_from_file_location('native_fixture_export', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='native-log-export-', dir='tmp') as directory:
            output = Path(directory)/'recording.json'
            module.export_fixture(FIXTURES/'events.jsonl', output)
            self.assertEqual(json.loads(output.read_text()), self.recording)
            self.assertEqual((output.parent/'events.jsonl').read_bytes(), (FIXTURES/'events.jsonl').read_bytes())
