"""敏感闸门测试：规则回归（CR 固定测试值）、判定器行为与采集/补分析接入。

规则用例移植自 reports/cr/cr-report-20261101-sensitive-rules 的固定测试值；
测试中的密钥均为合成假值，不使用任何真实凭据。输出断言只比对类别。
"""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image, ImageDraw, ImageFont

from scening.observer_config import load_config
from scening.sensitive_guard import SensitiveGuard, detect_text

# (名称, 输入, 期望类别集合)；期望None表示仅要求非空命中（保守阻断）
RULE_CASES = [
    # CR B1：身份证 X 结尾
    ("id_numeric_control", "110101199003070062", {"cn-id"}),
    ("id_x_lost", "11010119900307002X", {"cn-id"}),
    ("id_lower_x", "11010119900307002x", {"cn-id"}),
    # CR B2：卡号长度与分隔符
    ("card_plain_control", "4111111111111111", {"bank-card"}),
    ("card_spaces_control", "4111 1111 1111 1111", {"bank-card"}),
    ("card_ascii_hyphens", "4111-1111-1111-1111", {"bank-card"}),
    ("card_13_digits", "4000000000006", {"bank-card"}),
    ("card_15_digits", "378282246310005", {"bank-card"}),
    ("card_19_digits", "4000000000000000006", {"bank-card"}),
    ("labelled_card_missing_digit", "银行卡号=411111111111111", None),
    ("labelled_card_substitution", "银行卡号=4111111111111112", None),
    # CR B3：滑窗起点
    ("card_28_digit_chunk_boundary", "999999999999999999994111111111111111", {"bank-card"}),
    ("id_overlapping_candidate", "99999919110101199003070062", {"cn-id"}),
    # CR B4：前缀边界与私钥短语
    ("prefix_control", "sk-proj-***", {"openai-key"}),
    ("prefix_cjk_boundary", "密钥sk-proj-***", {"openai-key"}),
    ("prefix_fragmented_after_label", "API key s k-p ro j ***", {"openai-key"}),
    ("prefix_fragmented_control", "s k-p ro j ***", {"openai-key"}),
    ("pem_control", "BEGIN OPENSSH PRIVATE KEY", {"private-key"}),
    ("pem_line_break", "BEGIN OPENSSH\nPRIVATE KEY", {"private-key"}),
    ("pem_fragmented", "B E G I N RSA PRIVATE KEY", {"private-key"}),
    ("ordinary_task_word", "task-proj-example", set()),
    ("ordinary_risk_word", "risk-proj-example", set()),
    # CR B5：前缀表与兜底
    ("token_32_control", "Ab7Cd8Ef9Gh0Jk1Lm2Np3Qr4St5Uv6Wx", {"long-token"}),
    ("token_split_16_16", "Ab7Cd8Ef9Gh0Jk1L\nm2Np3Qr4St5Uv6Wx", {"split-token"}),
    ("token_hex_32", "secret=0123456789abcdef0123456789abcdef", {"credential-label"}),
    ("token_punctuation", "password=Ab7cd8ef+Gh9ij0kl/Mn1op2qr", {"credential-label"}),
    ("aws_asia", "ASIA1234567890ABCDEF", {"aws-key"}),
    ("github_fine_grained_fragmented", "github_pat_\nAb7Cd8Ef9Gh0Jk1L\nm2Np3Qr4St5Uv6Wx", None),
    ("short_password", "password=Ab7!pq9", {"credential-label"}),
    # CR B10：边界与对照
    ("boundary_19", "Ab7Cd8Ef9Gh0Jk1Lm2N", set()),
    ("boundary_20", "Ab7Cd8Ef9Gh0Jk1Lm2Np", {"long-token"}),
    ("boundary_sk_9", "sk-Ab7Cd8Ef", set()),
    ("boundary_sk_10", "sk-Ab7Cd8Ef9G", {"openai-key"}),
    ("bare_masked_body", "sk-************************************", set()),
    ("today", "Today is a quiet day.", set()),
    ("git", "git status clean", set()),
    ("token_your", "token: your application token here", set()),
]

SYNTHETIC_KEY_LINE = "sk-proj-Tq8mV2xR4wY6bN1cL5pH9zK3aS7dF0gJ"


def draw_text_image(text, size=(800, 200), font_size=36):
    """画一张深底浅字的测试图；只包含传入的合成文本。"""
    image = Image.new("RGB", size, (28, 30, 38))
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", font_size)
    except OSError:
        font = ImageFont.load_default()
    draw.text((30, 60), text, fill=(220, 224, 230), font=font)
    return image


def guard_config(**overrides):
    """构造privacy启动快照；默认与observer.yaml一致，测试可覆盖单项。"""
    values = {'enabled': True, 'sensitiveApps': ['com.1password.1password'],
              'appKeywords': [], 'ocrEnabled': True, 'longTokenMin': 20,
              'splitTokenMin': 12, 'splitJoinedMin': 24, 'cardCheck': True,
              'idCheck': True, 'labelCheck': True}
    values.update(overrides)
    from scening.observer_config import PrivacyConfig
    return PrivacyConfig.model_validate(values)


class DetectTextTests(unittest.TestCase):
    """规则回归：CR 报告固定测试值逐例比对类别。"""

    def test_cr_fixed_cases(self):
        for name, text, expected in RULE_CASES:
            with self.subTest(name):
                got = set(detect_text(text))
                if expected is None:
                    self.assertTrue(got, f'{name} 应有非空命中')
                else:
                    self.assertEqual(got, expected, name)


class SensitiveGuardTests(unittest.TestCase):
    """判定器：黑名单、开关、fail-closed 与零行放行。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='guard-test-', dir='tmp')
        self.addCleanup(self.temp.cleanup)
        self.image_path = Path(self.temp.name) / 'frame.jpg'
        image = draw_text_image("Today is a quiet day.")
        image.save(self.image_path, 'JPEG', quality=85)

    def test_disabled_allows(self):
        verdict = SensitiveGuard(guard_config(enabled=False)).evaluate(self.image_path)
        self.assertFalse(verdict.blocked)
        self.assertEqual(verdict.reason, 'disabled')

    def test_app_denylist_exact_and_prefix(self):
        guard = SensitiveGuard(guard_config())
        blocked = guard.evaluate(self.image_path, app='1Password', bundle_id='com.1password.1password')
        self.assertTrue(blocked.blocked)
        self.assertEqual(blocked.reason, 'app')
        prefix = guard.evaluate(self.image_path, bundle_id='com.1password.1password.helper')
        self.assertTrue(prefix.blocked)

    def test_app_keyword_casefold(self):
        guard = SensitiveGuard(guard_config(appKeywords=['密码箱']))
        verdict = guard.evaluate(self.image_path, app='我的密码箱App')
        self.assertTrue(verdict.blocked)

    def test_ocr_disabled_app_only(self):
        guard = SensitiveGuard(guard_config(ocrEnabled=False))
        verdict = guard.evaluate(self.image_path, app='Notes')
        self.assertFalse(verdict.blocked)
        self.assertEqual(verdict.reason, 'app-only')

    def test_ocr_error_blocks_fail_closed(self):
        guard = SensitiveGuard(guard_config())
        with mock.patch('scening.sensitive_guard.ocr_lines', side_effect=RuntimeError('boom')):
            verdict = guard.evaluate(self.image_path)
        self.assertTrue(verdict.blocked)
        self.assertEqual(verdict.reason, 'ocr-error')

    def test_ocr_empty_lines_allow(self):
        guard = SensitiveGuard(guard_config())
        with mock.patch('scening.sensitive_guard.ocr_lines', return_value=[]):
            verdict = guard.evaluate(self.image_path)
        self.assertFalse(verdict.blocked)
        self.assertEqual(verdict.reason, 'ocr-empty')

    def test_real_key_image_blocks(self):
        key_path = Path(self.temp.name) / 'key.jpg'
        draw_text_image(f"export KEY={SYNTHETIC_KEY_LINE}").save(key_path, 'JPEG', quality=85)
        verdict = SensitiveGuard(guard_config()).evaluate(key_path)
        self.assertTrue(verdict.blocked)
        self.assertEqual(verdict.reason, 'content')
        self.assertIn('openai-key', verdict.hits)


class CollectorGateTests(unittest.TestCase):
    """采集接入：_publish 在正式落盘前拦截，干净帧照常发布。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gate-collect-', dir='tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = load_config().with_overrides(
            home=self.root / 'home', screenshotDir=self.root / 'shots')
        (self.root / 'home').mkdir(parents=True)
        self.config.screenshotDir.mkdir()

    def _publish(self, image):
        from scening.capture import Display, Frame
        from scening.collector import SensingCollector
        collector = SensingCollector(self.config, backend=object(), app_provider=lambda display=None: (None, None))
        display = Display(1, 0, 0, *image.size)
        saved = collector.store.stage(
            Frame(image, datetime.now().astimezone(), display, 'Notes', 'com.apple.Notes'))
        collector._publish(saved, 'action')
        return collector

    def test_key_frame_blocked(self):
        """测试内容：将包含合成密钥的内存截图交给真实Vision与采集发布入口。

        期望结果：记录privacy_blocked状态，候选队列为空，整个截图目录JPEG数量为零。
        """
        collector = self._publish(draw_text_image(f"token={SYNTHETIC_KEY_LINE}", size=(1000, 240)))
        self.assertTrue(collector.candidates.empty())
        statuses = collector.drain_status()
        self.assertTrue(any(item.get('result') == 'privacy_blocked' for item in statuses))
        # 敏感判定完成后，递归核对整个截图目录的JPEG数量为零。
        self.assertFalse(list(self.config.screenshotDir.rglob('*.jpg')))

    def test_clean_frame_publishes(self):
        """测试内容：将普通英文文本的内存截图交给真实Vision与采集发布入口。

        期望结果：检查允许发布，正式候选队列包含一个候选；文件字节与路径由保存时序用例核对。
        """
        collector = self._publish(draw_text_image("Today is a quiet day.", size=(1000, 240)))
        self.assertEqual(collector.candidates.qsize(), 1)


class BackfillGateTests(unittest.TestCase):
    """补分析接入：真实OCR命中后删除敏感图，模型提交保持零次。"""

    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('scening.screenshot_backfill'), '缺少补分析入口')
        from scening import screenshot_backfill
        self.api = screenshot_backfill
        self.temp = tempfile.TemporaryDirectory(prefix='gate-backfill-', dir='tmp')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = load_config().with_overrides(home=self.home, screenshotDir=self.home / 'screenshots')
        self.config.screenshotDir.mkdir()

    def _picture(self, text):
        start = datetime(2026, 10, 30, 9, tzinfo=timezone(timedelta(hours=8)))
        path = self.config.screenshotDir / '2026-10-30' / f"{start:%Y-%m-%d_%H-%M-%S}_m1_action.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        draw_text_image(text, size=(1000, 240)).save(path, 'JPEG', quality=85)
        return path

    def test_sensitive_history_image_deleted(self):
        path = self._picture(f"export KEY={SYNTHETIC_KEY_LINE}")
        calls = []

        def fake_analyze(image, frames=None):
            calls.append(image)
            raise AssertionError('敏感图不应提交模型')

        from scening.kmh_interpreter import KMHInterpreter
        model = mock.Mock(spec=KMHInterpreter)
        model.analyze.side_effect = fake_analyze
        result = self.api.backfill_day(self.config, '2026-10-30', interpreter=model)
        self.assertEqual(result['privacyBlocked'], 1)
        self.assertEqual(result['modelCalls'], 0)
        self.assertFalse(path.exists(), '确认敏感的积压原图应删除')
        self.assertEqual(result['remaining'], 0)
        self.assertEqual(result['state'], 'completed')
        index = json.loads((self.config.screenshotDir / '2026-10-30' / 'index.json').read_text())
        self.assertEqual(index['images'], [])

    def test_automatic_sensitive_history_image_deleted(self):
        """真实Vision OCR在自动队列同样删除敏感图，拼图与模型保持零次。"""
        from scening.observe_activity import ActivityPipeline
        from scening.screenshot_queue import ScreenshotQueue
        path = self._picture(f"export KEY={SYNTHETIC_KEY_LINE}")
        model = mock.Mock()
        pipeline = ActivityPipeline(self.home, interpreter=model, config=self.config)
        with mock.patch('scening.observe_activity.log_event'):
            result = ScreenshotQueue(self.config, '2026-10-30').step(pipeline)
        self.assertEqual(result, 'privacy_blocked')
        model.analyze.assert_not_called()
        self.assertFalse(path.exists())
        index = json.loads((self.config.screenshotDir / '2026-10-30' / 'index.json').read_text())
        self.assertEqual(index['images'], [])


if __name__ == '__main__':
    unittest.main()
