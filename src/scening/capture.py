"""采集边界和帧契约；原生采集会话由采集线程持有。

采用 ScreenCaptureKit 多屏最新帧和 pynput 输入监听。
后端可替换，用于双屏回放；键盘内容只表达输入事件，具体按键文本保持在监听边界内。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Tuple
import time

from PIL import Image
from scening.permissions import screen_capture_allowed
from scening.screen_stream import StreamCapture, StreamFailure


@dataclass(frozen=True)
class Display:
    """Quartz 逻辑坐标中的显示器。系统 ID 与像素尺寸参与采集布局判断。"""
    index: int
    left: int
    top: int
    width: int
    height: int
    system_id: int = 0
    pixels: Optional[Tuple[int, int]] = None

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
    """ScreenCaptureKit、Quartz 与 pynput 的本机边界。"""

    def __init__(self, shutdown_timeout, refresh_interval, capture_timeout):
        self._listeners = []
        self._shutdown_timeout = shutdown_timeout
        self._refresh_interval = refresh_interval
        self._capture_timeout = capture_timeout
        self._layout = None
        self._streams = None
        self._retiring = None
        self._allowed = False
        self._next_permission_check = 0.0
        self._retry_at = 0.0
        self._started_at = 0.0
        self._issue = None

    def displays(self):
        """读取 Quartz 显示布局。保持旧截图入口的名义像素尺寸与屏幕顺序。"""
        import Quartz
        error, ids, _ = Quartz.CGGetActiveDisplayList(32, None, None)
        if error:
            raise OSError(f'显示器布局读取失败（{error}）')
        displays = []
        for index, display_id in enumerate(ids, 1):
            bounds = Quartz.CGDisplayBounds(display_id)
            pixels = (Quartz.CGDisplayPixelsWide(display_id), Quartz.CGDisplayPixelsHigh(display_id))
            displays.append(Display(index, int(bounds.origin.x), int(bounds.origin.y),
                                    int(bounds.size.width), int(bounds.size.height), display_id, pixels))
        return displays

    def prepare_capture(self, displays, fps):
        """按布局维护一组流。授权按布局检查间隔复核，失败后延迟重试。"""
        layout = (tuple(displays), fps)
        if layout != self._layout:
            self.pause_capture()
            self._layout = layout
            self._retry_at = 0.0
        if self._retiring is not None and self._retiring.reap():
            self._retiring = None
        if not displays:
            return
        now = time.monotonic()
        if now >= self._next_permission_check:
            self._allowed = screen_capture_allowed()
            if not self._allowed:
                self.pause_capture()
            self._next_permission_check = now + self._refresh_interval
        if self._allowed and self._streams is None and self._retiring is None and now >= self._retry_at:
            try:
                self._streams = StreamCapture(displays, fps)
            except OSError as error:
                self._issue = str(error)
                self._retry_at = now + self._refresh_interval
            else:
                self._started_at = now
                self._issue = None

    def pause_capture(self):
        """立即失效各屏最新帧并请求停流，唤醒后等待旧会话收尾再开流。"""
        self._next_permission_check = 0.0
        if self._streams is not None:
            self._streams.stop()
            self._retiring, self._streams = self._streams, None

    def grab(self, display):
        """读取指定屏最新的观察。无新帧时沿用采集器已持有的最新帧。"""
        if not self._allowed:
            raise PermissionError('等待屏幕录制授权')
        if self._streams is None:
            if self._issue is not None:
                raise StreamFailure(self._issue)
            return None
        now = time.monotonic()
        try:
            return self._streams.take(display, startup_expired=now - self._started_at >= self._capture_timeout)
        except StreamFailure as error:
            self._issue = str(error)
            self._retry_at = now + self._refresh_interval
            self.pause_capture()
            raise

    def pointer(self):
        """读取与 Quartz 显示布局一致的全局指针坐标。"""
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
        """并行发起停流和停止监听，在同一退出预算内等待两者回收。"""
        deadline = time.monotonic() + self._shutdown_timeout
        self.pause_capture()
        for listener in self._listeners:
            listener.stop()
        try:
            for listener in self._listeners:
                listener.join(timeout=max(0, deadline-time.monotonic()))
                if listener.is_alive():
                    raise RuntimeError('键鼠监听退出超时')
            self._listeners.clear()
        finally:
            if self._retiring is not None:
                if not self._retiring.reap(max(0, deadline-time.monotonic())):
                    raise RuntimeError('ScreenCaptureKit 停流超时')
                self._retiring = None
