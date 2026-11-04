"""采集边界和帧契约；原生资源仅在采集线程内创建与释放。

采用 MSS 多屏缓存和 pynput 输入监听。
后端可替换，用于双屏回放；键盘内容只表达输入事件，具体按键文本保持在监听边界内。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Tuple
import time

from PIL import Image
from scening.permissions import screen_capture_allowed


@dataclass(frozen=True)
class Display:
    """MSS 逻辑像素中的一块显示器；位置与尺寸同时作为缓存身份。"""
    index: int
    left: int
    top: int
    width: int
    height: int

    def contains(self, point: Tuple[float, float]) -> bool:
        """判断输入坐标是否属于本屏，右边界和下边界交给相邻屏。"""
        x, y = point
        return self.left <= x < self.left + self.width and self.top <= y < self.top + self.height


@dataclass
class Frame:
    """一个采集时刻的图片及应用身份；图片生命周期由采集器持有。"""
    image: Image.Image
    at: datetime
    display: Display
    app: Optional[str] = None
    bundle_id: Optional[str] = None


@dataclass(frozen=True)
class InputEvent:
    """输入边界元信息；kind 为 click/key/scroll，时间使用同一单调时钟。"""
    kind: str
    x: float
    y: float
    monotonic: float


def display_at(displays, point):
    """按坐标选屏；屏幕之外返回 None，调用者等待有效帧。"""
    return next((display for display in displays if display.contains(point)), None)


class NativeBackend:
    """MSS、Quartz 与 pynput 的本机边界，实现按需导入及线程内生命周期。"""

    def __init__(self, shutdown_timeout):
        self._sct = None
        self._listeners = []
        self._shutdown_timeout = shutdown_timeout

    def displays(self):
        """重新读取屏幕布局；本函数与 grab、close 均由同一采集线程调用。"""
        import mss
        if self._sct is not None:
            self._sct.close()
        self._sct = mss.mss()
        return [Display(i, item['left'], item['top'], item['width'], item['height'])
                for i, item in enumerate(self._sct.monitors[1:], 1)]

    def grab(self, display):
        """抓取指定逻辑显示器，返回原尺寸 RGB 图片；异常交给采集器记录。"""
        if not screen_capture_allowed():
            raise PermissionError('等待屏幕录制授权')
        shot = self._sct.grab({'left': display.left, 'top': display.top,
                               'width': display.width, 'height': display.height})
        return Image.frombytes('RGB', shot.size, shot.rgb)

    def pointer(self):
        """读取 Quartz 全局指针坐标，与 MSS 在 macOS 中使用的坐标对应。"""
        import Quartz
        point = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
        return float(point.x), float(point.y)

    def idle_seconds(self):
        """使用系统输入空闲计数，涵盖键盘、鼠标与触控板。"""
        import Quartz
        return float(Quartz.CGEventSourceSecondsSinceLastEventType(
            Quartz.kCGEventSourceStateCombinedSessionState, Quartz.kCGAnyInputEventType))

    def display_asleep(self):
        """读取系统主显示器睡眠状态，作为采集暂停信号。"""
        import Quartz
        return bool(Quartz.CGDisplayIsAsleep(Quartz.CGMainDisplayID()))

    def start_inputs(self, submit, clock):
        """申请并启动键鼠监听；缺权返回 False，定时观察仍可继续。

        参数 submit 接收 InputEvent，clock 返回单调时间。监听回调只入队。
        系统权限申请每次后端启动最多一次；已启动监听由 close 停止并回收。
        """
        import Quartz
        from pynput import keyboard, mouse
        if hasattr(Quartz, 'CGPreflightListenEventAccess') and not Quartz.CGPreflightListenEventAccess():
            Quartz.CGRequestListenEventAccess()
            if not Quartz.CGPreflightListenEventAccess():
                return False

        def click(x, y, button, pressed):
            if pressed:
                submit(InputEvent('click', x, y, clock()))

        def key(value):
            try:
                x, y = self.pointer()
                submit(InputEvent('key', x, y, clock()))
            except Exception:
                # 坐标读取失败时跳过该事件，周期观察仍可提供画面。
                return

        def scroll(x, y, dx, dy):
            submit(InputEvent('scroll', x, y, clock()))

        for listener in (mouse.Listener(on_click=click, on_scroll=scroll), keyboard.Listener(on_press=key)):
            listener.start()
            self._listeners.append(listener)
        return True

    def close(self):
        """先停止监听，再关闭本线程的 MSS；退出等待由采集器统一控制。"""
        deadline = time.monotonic() + self._shutdown_timeout
        for listener in self._listeners:
            listener.stop()
        for listener in self._listeners:
            listener.join(timeout=max(0, deadline-time.monotonic()))
            if listener.is_alive():
                raise RuntimeError('键鼠监听退出超时')
        self._listeners.clear()
        if self._sct is not None:
            self._sct.close()
            self._sct = None
