"""内存OCR专项；图片与提交保持真实，时序用例仅替换OCR文本边界。"""
from datetime import datetime, timezone
import io
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from scening.capture import Display, Frame
from scening.capture_metadata import metadata_path
from scening.collector import SensingCollector
from scening.observer_config import load_config
from scening.selection import image_difference
from scening.sensitive_guard import SensitiveGuard
from test_sensitive_guard import draw_text_image


class MemoryOCRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='memory-ocr-', dir='tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = load_config().with_overrides(home=self.root/'home', screenshotDir=self.root/'shots')

        class Backend:
            def close(self):
                pass

        self.collector = SensingCollector(self.config, backend=Backend(), app_provider=lambda *_: (None, None))
        self.addCleanup(self.collector.close)

    def stage(self, color='white'):
        """构造指定颜色的合成截图，通过真实编码入口返回内存JPEG。"""
        with Image.new('RGB', (240, 120), color) as image:
            return self.collector.store.stage(Frame(image, datetime(2026, 11, 4, tzinfo=timezone.utc),
                                                    Display(1, 0, 0, 240, 120), 'Notes', 'com.apple.Notes'))

    def pictures(self):
        """递归枚举截图目录中的JPEG，包含日期目录与兼容临时目录。"""
        return list(self.config.screenshotDir.rglob('*.jpg'))

    def test_stage_retains_encoded_snapshot_without_files(self):
        """测试内容：暂存白色截图后修改源图，检查快照与磁盘。

        期望结果：内存JPEG保留原尺寸及白色画面；暂存和丢弃后的截图目录JPEG数量均为零。
        """
        with Image.new('RGB', (240, 120), 'white') as image:
            pending = self.collector.store.stage(Frame(image, datetime.now().astimezone(),
                                                      Display(1, 0, 0, 240, 120)))
            image.paste('black', (0, 0, 240, 120))
        self.assertIsInstance(pending.jpeg, bytes)
        with Image.open(io.BytesIO(pending.jpeg)) as snapshot:
            self.assertEqual(snapshot.size, (240, 120))
            self.assertEqual(snapshot.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(self.pictures(), [])
        self.collector.store.discard(pending)
        self.assertEqual(self.pictures(), [])

    def test_publish_checks_memory_before_any_picture_write(self):
        """测试内容：让OCR返回普通文本，检查进入OCR时及允许发布后的文件状态。

        期望结果：OCR接收内存字节且此时截图目录为空；通过后正式文件与内存JPEG逐字节
        一致，尺寸、应用身份保持，采集信息文件存在。OCR文本固定，编码与保存执行真实代码。
        """
        pending = self.stage()
        def text(source):
            # OCR开始时检查输入介质和整个截图目录，确认待判定图片仍在内存中。
            self.assertIsInstance(source, bytes)
            self.assertEqual(self.pictures(), [])
            return ['Today is a quiet day.']
        with patch('scening.sensitive_guard.ocr_lines', side_effect=text):
            self.collector._publish(pending, 'periodic')
        candidate = self.collector.next_candidate(timeout=0)
        # OCR通过后实际读取发布路径，核对图片已保存且内容与受检字节一致。
        self.assertEqual(candidate.saved.path.read_bytes(), pending.jpeg)
        self.assertEqual(candidate.saved.size, pending.size)
        self.assertEqual((candidate.saved.app, candidate.saved.bundle_id), ('Notes', 'com.apple.Notes'))
        self.assertTrue(metadata_path(candidate.saved.path).exists())

    def test_sensitive_and_ocr_failure_leave_zero_pictures(self):
        """测试内容：分别模拟OCR识别出合成密钥、OCR执行抛错两种情况。

        期望结果：两种情况结束后，截图目录JPEG数量均为零，正式候选队列为空。
        """
        for answer in (['sk-proj-synthetic'], RuntimeError('synthetic OCR failure')):
            with self.subTest(answer=type(answer).__name__):
                with patch('scening.sensitive_guard.ocr_lines', side_effect=answer if isinstance(answer, Exception) else None,
                           return_value=answer):
                    self.collector._publish(self.stage(), 'periodic')
                self.assertEqual(self.pictures(), [])
                self.assertTrue(self.collector.candidates.empty())

    def test_stop_during_ocr_prevents_picture_commit(self):
        """测试内容：OCR执行期间请求停止，随后让OCR返回普通文本。

        期望结果：停止标记生效，截图目录JPEG数量为零，正式候选队列为空。
        """
        def text(_):
            self.collector.request_stop()
            return ['ordinary document']
        with patch('scening.sensitive_guard.ocr_lines', side_effect=text):
            self.collector._publish(self.stage(), 'periodic')
        self.assertEqual(self.pictures(), [])
        self.assertTrue(self.collector.candidates.empty())

    def test_memory_and_file_difference_match(self):
        """测试内容：比较黑白两帧的内存JPEG差异，再将相同字节保存为文件进行比较。

        期望结果：差异值与独立解码像素计算结果一致，内存和文件两条比较路径结果一致。
        """
        left, right = self.stage('black'), self.stage('white')
        value = image_difference(left, right, self.config.scening.missingImageDifference)
        with left.open_image() as a, right.open_image() as b:
            expected = sum((x-y)**2 for x, y in zip(a.getpixel((0, 0)), b.getpixel((0, 0))))
        self.assertEqual(value, expected)
        a = self.collector.store.promote(left, 'left')
        b = self.collector.store.promote(right, 'right')
        self.assertEqual(value, image_difference(a, b, self.config.scening.missingImageDifference))

    def test_stale_candidate_leaves_only_previous_formal_picture(self):
        """测试内容：先后发布两张采集时间相同、画面不同且OCR通过的候选。

        期望结果：第二张按过旧候选处理，目录仅保留第一张正式图片，队列仅含一个候选。
        """
        with patch('scening.sensitive_guard.ocr_lines', return_value=['ordinary document']):
            self.collector._publish(self.stage(), 'action')
            self.collector._publish(self.stage('black'), 'action')
        self.assertEqual(len(self.pictures()), 1)
        self.assertEqual(self.collector.candidates.qsize(), 1)

    def test_publish_failure_preserves_formal_picture(self):
        """测试内容：已有正式图时，模拟新候选排他发布阶段发生文件错误。

        期望结果：保存错误向上传播，旧图字节保持原值；目录仅保留旧图，候选队列为空，
        本次提交产生的临时文件数量为零。仅替换发布故障点，其余文件操作保持真实。
        """
        with patch('scening.sensitive_guard.ocr_lines', return_value=['ordinary document']):
            pending = self.stage()
            formal = self.collector.store.promote(pending, 'periodic')
            with patch('scening.frame_store.os.link', side_effect=OSError('synthetic write failure')):
                with self.assertRaises(OSError):
                    self.collector._publish(self.stage('black'), 'periodic')
        self.assertEqual(formal.path.read_bytes(), pending.jpeg)
        self.assertEqual(self.pictures(), [formal.path])
        self.assertTrue(self.collector.candidates.empty())
        self.assertEqual(list(formal.path.parent.glob('*.tmp')), [])

    def test_memory_promotion_protects_same_second_name(self):
        """测试内容：将同一秒、同一屏幕和用途的两张内存快照保存为正式图。

        期望结果：两张图分配不同路径，各文件分别保留对应快照的完整JPEG字节。
        """
        first, second = self.stage('white'), self.stage('black')
        a = self.collector.store.promote(first, 'action')
        b = self.collector.store.promote(second, 'action')
        self.assertNotEqual(a.path, b.path)
        self.assertEqual(a.path.read_bytes(), first.jpeg)
        self.assertEqual(b.path.read_bytes(), second.jpeg)

    def test_compatible_file_candidate_still_publishes(self):
        """测试内容：经兼容入口创建临时文件候选，OCR通过后发布并执行清理。

        期望结果：正式图与临时源字节一致；清理临时源后源路径消失，清理正式图时正式文件保留。
        """
        with Image.new('RGB', (240, 120), 'white') as image:
            saved = self.collector.store.save(Frame(image, datetime.now().astimezone(),
                                                   Display(1, 0, 0, 240, 120)), 'compat')
        with patch('scening.sensitive_guard.ocr_lines', return_value=['ordinary document']):
            self.collector._publish(saved, 'compat')
        candidate = self.collector.next_candidate(timeout=0)
        self.assertEqual(candidate.saved.path.read_bytes(), saved.path.read_bytes())
        self.collector.store.discard(saved)
        self.assertFalse(saved.path.exists())
        self.collector.store.discard(candidate.saved)
        self.assertTrue(candidate.saved.path.exists())

    def test_stage_encoding_failure_keeps_source_and_files(self):
        """测试内容：在截图暂存的JPEG编码阶段注入保存异常。

        期望结果：编码错误向上传播，源图仍可读取且像素保持原值，截图目录JPEG数量为零。
        """
        with Image.new('RGB', (240, 120), 'white') as image:
            with patch.object(Image.Image, 'save', side_effect=OSError('synthetic encode failure')):
                with self.assertRaises(OSError):
                    self.collector.store.stage(Frame(image, datetime.now().astimezone(),
                                                    Display(1, 0, 0, 240, 120)))
            self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(self.pictures(), [])

    def test_real_vision_memory_and_file_verdicts_match(self):
        """测试内容：将普通文本图、合成密钥图分别交给真实Vision的内存和文件入口。

        期望结果：两入口判定完全一致，普通文本允许、合成密钥拦截，OCR正常完成。
        此处写入的fixture.jpg作为文件入口的对照输入，发布保存时序由独立用例验证。
        """
        guard = SensitiveGuard(self.config.privacy)
        for text, expected in [('Today is a quiet day.', False), ('token=sk-proj-synthetic', True)]:
            with self.subTest(blocked=expected):
                image = draw_text_image(text, size=(1000, 240))
                self.addCleanup(image.close)
                buffer = io.BytesIO()
                image.save(buffer, 'JPEG', quality=self.config.scening.jpegQuality)
                data = buffer.getvalue()
                path = self.root/'fixture.jpg'
                path.write_bytes(data)
                memory, file = guard.evaluate(data), guard.evaluate(path)
                self.assertEqual(memory, file)
                self.assertEqual(memory.blocked, expected)
                self.assertNotEqual(memory.reason, 'ocr-error')

    def test_invalid_memory_image_fails_closed(self):
        """测试内容：向真实OCR入口提交损坏的内存图片字节。

        期望结果：返回blocked=True、reason=ocr-error，按OCR错误阻断该输入。
        """
        result = SensitiveGuard(self.config.privacy).evaluate(b'invalid image data')
        self.assertEqual((result.blocked, result.reason), (True, 'ocr-error'))

    def test_blacklisted_memory_frame_bypasses_ocr(self):
        """测试内容：以应用黑名单中的采集身份检查一张内存JPEG。

        期望结果：直接返回应用阻断，reason=app，OCR调用次数为零，截图目录JPEG数量为零。
        """
        with patch('scening.sensitive_guard.ocr_lines') as ocr:
            result = SensitiveGuard(self.config.privacy).evaluate(self.stage().jpeg, app='微信', bundle_id='com.tencent.xinWeChat')
        self.assertEqual((result.blocked, result.reason), (True, 'app'))
        ocr.assert_not_called()
        self.assertEqual(self.pictures(), [])

    def test_sigkill_during_ocr_leaves_zero_pictures(self):
        """测试内容：独立子进程暂存图片并阻塞在OCR入口，父进程发送SIGKILL。

        期望结果：OCR等待期间及子进程强制退出后，截图目录JPEG数量均为零；子进程退出码
        对应SIGKILL。OCR等待点为替身，图片暂存和发布入口使用真实代码，仅终止测试子进程。
        """
        script = '''
from pathlib import Path
from datetime import datetime
import sys
from unittest.mock import patch
from PIL import Image
from scening.capture import Display, Frame
from scening.collector import SensingCollector
from scening.observer_config import load_config
config=load_config().with_overrides(home=Path(sys.argv[1])/'home', screenshotDir=Path(sys.argv[1])/'shots')
collector=SensingCollector(config, backend=object(), app_provider=lambda *_: (None,None))
image=Image.new('RGB',(240,120),'white')
pending=collector.store.stage(Frame(image,datetime.now().astimezone(),Display(1,0,0,240,120)))
def ocr(source):
    print('ocr-ready',flush=True)
    sys.stdin.readline()
    return ['ordinary document']
with patch('scening.sensitive_guard.ocr_lines',side_effect=ocr):
    collector._publish(pending,'periodic')
'''
        process = subprocess.Popen([sys.executable, '-c', script, str(self.root.resolve())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=10), 'child OCR boundary timeout')
            self.assertEqual(process.stdout.readline().strip(), 'ocr-ready')
            self.assertEqual(self.pictures(), [])
            process.send_signal(signal.SIGKILL)
            _, errors = process.communicate(timeout=10)
            self.assertEqual(process.returncode, -signal.SIGKILL, errors)
            self.assertEqual(self.pictures(), [])
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)
