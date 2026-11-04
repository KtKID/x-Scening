"""下游回归使用的候选源替身，保留测试原有的真实图片与文件写入路径。"""
from PIL import Image

from scening import observe_activity as activity
from scening.capture import Display, Frame
from scening.frame_store import Candidate, FrameStore


class PreparedSource:
    """只替换系统取帧边界，正式 JPEG 的命名、保存和候选交付使用真实实现。"""
    @staticmethod
    def frame_provider(at, config):
        """默认合成黑色帧，测试可覆盖此取帧边界。"""
        return Image.new('RGB', (200, 100), 'black')

    def __init__(self, config, app_provider=None):
        self.config = config
        self.app_provider = app_provider

    def __enter__(self):
        self.store = FrameStore(self.config.screenshotDir, self.config.scening.jpegQuality)
        return self

    def __exit__(self, *args):
        self.store.close()

    def request_stop(self):
        """受控源没有后台生产线程，停止由调用方事件结束。"""
        return None

    def drain_status(self):
        return []

    def next_candidate(self, timeout=None):
        at = activity.datetime.now().astimezone().replace(microsecond=0)
        app, bundle = self.app_provider() if self.app_provider else (None, None)
        with type(self).frame_provider(at, self.config) as image:
            display = Display(1, 0, 0, *image.size)
            saved = self.store.save(Frame(image, at, display, app, bundle),
                                    'periodic', temporary=False)
        return Candidate(saved, 'regression_fixture')
