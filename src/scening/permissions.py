"""macOS 屏幕录制权限的唯一查询与申请入口。"""
import ctypes
from functools import lru_cache
import sys


@lru_cache(maxsize=2)
def _permission_api(name):
    """缓存 CoreGraphics 授权函数；异常交给调用方记录。"""
    if sys.platform != 'darwin':
        raise RuntimeError('当前截图入口适用于 macOS')
    library = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    function = getattr(library, name)
    function.argtypes = []
    function.restype = ctypes.c_bool
    return function


def screen_capture_allowed():
    """只读查询当前启动程序的屏幕录制授权状态。"""
    return bool(_permission_api('CGPreflightScreenCaptureAccess')())


def request_screen_capture_access():
    """调用系统申请接口，由 macOS 展示提示及管理最终授权。"""
    return bool(_permission_api('CGRequestScreenCaptureAccess')())
