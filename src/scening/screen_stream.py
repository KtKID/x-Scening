"""ScreenCaptureKit 原生边界。像素始终留在进程内，读取完成即归还系统缓冲。"""
from __future__ import annotations

import ctypes
from dataclasses import dataclass
from functools import lru_cache
import hashlib
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
from typing import Optional

from PIL import Image


_SOURCE = Path(__file__).with_suffix('.m')
_BUNDLED_LIBRARY = _SOURCE.with_name('_screen_stream.dylib')
_FRAME_FAILED, _FRAME_EMPTY, _FRAME_COMPLETE, _FRAME_IDLE, _FRAME_UNAVAILABLE, _FRAME_WAITING = range(-1, 5)


def build_library(*, bundled=False):
    """编译并原子发布本机桥接库。开发按源码与架构缓存，发行包在打包时预编译。"""
    if sys.platform != 'darwin':
        raise OSError('屏幕采集需要 macOS ScreenCaptureKit')
    digest = hashlib.sha256(_SOURCE.read_bytes()).hexdigest()[:16]
    cache = _SOURCE.parents[2] / 'desktop' / '.cache' / 'screen-stream'
    target = _BUNDLED_LIBRARY if bundled else cache / f'{platform.machine()}-{digest}.dylib'
    if not bundled and target.is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    # 并行启动可各自编译，读者只看见完整的成品。
    with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
        output = Path(temporary) / target.name
        try:
            subprocess.run([
                '/usr/bin/clang', '-arch', platform.machine(), '-dynamiclib', '-O2',
                '-fobjc-arc', '-fblocks', '-mmacosx-version-min=12.3', '-Werror=unguarded-availability-new',
                '-framework', 'Foundation', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
                '-framework', 'ScreenCaptureKit', '-o', str(output), str(_SOURCE),
            ], check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            raise OSError('ScreenCaptureKit 桥接编译失败：' + error.stderr.strip()) from error
        output.replace(target)
    return target


class _NativeDisplay(ctypes.Structure):
    _fields_ = [('id', ctypes.c_uint32), ('width', ctypes.c_size_t), ('height', ctypes.c_size_t)]


class _NativeFrame(ctypes.Structure):
    _fields_ = [('pixel', ctypes.c_void_p), ('data', ctypes.c_void_p),
                ('width', ctypes.c_size_t), ('height', ctypes.c_size_t),
                ('stride', ctypes.c_size_t), ('captured_at', ctypes.c_double), ('error', ctypes.c_int64)]


@lru_cache(maxsize=1)
def _library():
    """加载发行包的预编译桥接库，源码入口则复用开发构建缓存。"""
    library = ctypes.CDLL(str(_BUNDLED_LIBRARY if _BUNDLED_LIBRARY.is_file() else build_library()))
    pointer = ctypes.c_void_p
    signatures = {
        'open': ([ctypes.POINTER(_NativeDisplay), ctypes.c_size_t, ctypes.c_double], pointer),
        'take': ([pointer, ctypes.c_uint32, ctypes.POINTER(_NativeFrame)], ctypes.c_int),
        'frame_release': ([pointer], None),
        'stop': ([pointer], None),
        'wait': ([pointer, ctypes.c_double], ctypes.c_bool),
        'release': ([pointer], None),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(library, 'scening_stream_' + name)
        function.argtypes = arguments
        function.restype = result
    return library


@dataclass(frozen=True)
class StreamFrame:
    """一次实际屏幕观察。系统确认静止时仅返回时间，像素复用上一张完整帧。"""
    captured_at: float
    image: Optional[Image.Image]


class StreamFailure(OSError):
    """采集流启动或运行失败，需要关闭旧会话后重试。"""


class StreamCapture:
    """一组显示器的采集流。创建和停止异步发起，旧流收尾前禁止建立替代流。"""

    def __init__(self, displays, fps):
        self._lib = _library()
        specs = (_NativeDisplay * len(displays))(*[
            _NativeDisplay(display.system_id, *display.pixels) for display in displays
        ])
        self._handle = self._lib.scening_stream_open(specs, len(specs), fps)
        if not self._handle:
            raise StreamFailure('无法创建 ScreenCaptureKit 会话')

    def take(self, display, *, startup_expired=False):
        """取走最新帧并复制为 Pillow 图。无更新继续用现有缓存，故障由采集器记录。"""
        frame = _NativeFrame()
        state = self._lib.scening_stream_take(self._handle, display.system_id, ctypes.byref(frame))
        if state == _FRAME_FAILED:
            raise StreamFailure(f'ScreenCaptureKit 流失败（{frame.error}）')
        if state == _FRAME_UNAVAILABLE:
            raise OSError('系统暂停了该屏的画面输出')
        if state == _FRAME_WAITING and startup_expired:
            raise StreamFailure('等待 ScreenCaptureKit 首帧超时')
        if state in (_FRAME_EMPTY, _FRAME_WAITING):
            return None
        if state == _FRAME_IDLE:
            return StreamFrame(frame.captured_at, None)
        if state != _FRAME_COMPLETE or not frame.pixel:
            raise StreamFailure('ScreenCaptureKit 帧状态无效')
        try:
            if not frame.data or frame.stride < frame.width * 4:
                raise StreamFailure('ScreenCaptureKit 像素缓冲无效')
            data = ctypes.string_at(frame.data, frame.stride * frame.height)
            image = Image.frombytes('RGB', (frame.width, frame.height), data, 'raw', 'BGRX', frame.stride, 1)
            return StreamFrame(frame.captured_at, image)
        finally:
            self._lib.scening_stream_frame_release(frame.pixel)

    def stop(self):
        """立即使帧槽失效，并通知系统停止各屏采集。"""
        self._lib.scening_stream_stop(self._handle)

    def reap(self, timeout=0):
        """确认系统完成停止后释放会话。超时保留句柄供下一轮继续等待。"""
        if not self._lib.scening_stream_wait(self._handle, timeout):
            return False
        self._lib.scening_stream_release(self._handle)
        self._handle = None
        return True


if __name__ == '__main__':
    print(build_library(bundled=sys.argv[1:] == ['--bundled']))
