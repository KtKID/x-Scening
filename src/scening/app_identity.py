"""从系统实时进程和窗口所属应用取得截图身份，采集线程可独立查询。"""
import ctypes
from functools import lru_cache
import math


class ProcessSerialNumber(ctypes.Structure):
    """系统进程序号的原生布局，用于查询实时前台PID。"""
    _fields_ = [('high', ctypes.c_uint32), ('low', ctypes.c_uint32)]


@lru_cache(maxsize=1)
def _native_runtime():
    """缓存库句柄与函数签名；应用身份在每次调用时按PID重新解析。"""
    appkit = ctypes.CDLL('/System/Library/Frameworks/AppKit.framework/AppKit')
    objc = ctypes.CDLL('/usr/lib/libobjc.A.dylib')
    objc.objc_getClass.argtypes = [ctypes.c_char_p]
    objc.objc_getClass.restype = ctypes.c_void_p
    objc.sel_registerName.argtypes = [ctypes.c_char_p]
    objc.sel_registerName.restype = ctypes.c_void_p
    objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    objc.objc_msgSend.restype = ctypes.c_void_p
    carbon = ctypes.CDLL('/System/Library/Frameworks/Carbon.framework/Carbon')
    carbon.GetFrontProcess.argtypes = [ctypes.POINTER(ProcessSerialNumber)]
    carbon.GetFrontProcess.restype = ctypes.c_int32
    carbon.GetProcessPID.argtypes = [ctypes.POINTER(ProcessSerialNumber), ctypes.POINTER(ctypes.c_int32)]
    carbon.GetProcessPID.restype = ctypes.c_int32
    return appkit, objc, carbon


def frontmost_pid():
    """直接查询系统当前激活进程，返回PID或未知。

    查询使用系统实时进程接口，避免共享NSWorkspace随主线程事件循环更新的状态。
    系统返回失败或无有效PID时返回None；动态库加载错误向调用方传播。
    本函数只读系统状态，适用于采集线程和应用切换验收。
    """
    _, _, carbon = _native_runtime()
    serial, pid = ProcessSerialNumber(), ctypes.c_int32()
    if carbon.GetFrontProcess(ctypes.byref(serial)) or carbon.GetProcessPID(ctypes.byref(serial), ctypes.byref(pid)):
        return None
    return pid.value if pid.value > 0 else None


def application_for_pid(pid):
    """按确定PID读取名称和bundle ID，返回二元组；系统辅助进程按未知处理。

    名称与bundle ID属于进程的固定身份，每次通过指定PID取得NSRunningApplication。
    参数pid来自系统窗口或实时前台查询；无效/已退出/后台辅助进程返回(None, None)。
    每次创建并释放autorelease pool，保持采集线程长期查询的资源边界。
    """
    if pid is None or pid <= 0:
        return None, None
    _, objc, _ = _native_runtime()

    def send(receiver, selector):
        return objc.objc_msgSend(receiver, objc.sel_registerName(selector)) if receiver else None

    pool = send(objc.objc_getClass(b'NSAutoreleasePool'), b'new')
    try:
        lookup = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int)(('objc_msgSend', objc))
        app = lookup(objc.objc_getClass(b'NSRunningApplication'), objc.sel_registerName(b'runningApplicationWithProcessIdentifier:'), pid)
        if not app:
            return None, None
        integer = ctypes.CFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)(('objc_msgSend', objc))
        if integer(app, objc.sel_registerName(b'activationPolicy')) != 0:
            return None, None

        def string(selector):
            pointer = send(send(app, selector), b'UTF8String')
            return ctypes.string_at(pointer).decode('utf-8') if pointer else None

        return string(b'localizedName'), string(b'bundleIdentifier')
    finally:
        send(pool, b'drain')


def display_window_pids(windows, display):
    """按系统前后层级列出与目标屏相交的可见普通窗口所属PID，保持顺序去重。

    windows为CGWindowListCopyWindowInfo的只读元信息，display使用Quartz逻辑坐标。
    菜单栏、浮层、透明窗口、零面积与无效矩形跳过；负坐标和跨屏窗口按矩形相交处理。
    返回PID列表，辅助进程的应用资格由application_for_pid继续校验。
    """
    result = []
    for window in windows:
        if window.get('kCGWindowLayer') != 0 or window.get('kCGWindowAlpha', 1) <= 0:
            continue
        bounds = window.get('kCGWindowBounds', {})
        try:
            x, y, width, height = (float(bounds[key]) for key in ('X', 'Y', 'Width', 'Height'))
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (x, y, width, height)) or width <= 0 or height <= 0:
            continue
        if x >= display.left + display.width or x + width <= display.left or y >= display.top + display.height or y + height <= display.top:
            continue
        pid = window.get('kCGWindowOwnerPID')
        if isinstance(pid, int) and pid > 0 and pid not in result:
            result.append(pid)
    return result


def frontmost_application(display=None):
    """返回当前系统应用，提供display时返回该屏最前方可见普通窗口所属应用。

    无display时使用实时前台PID；多屏采集时由系统窗口顺序与矩形确认所选屏归属，
    再按窗口PID读取固定身份。两条路径均独立于共享NSWorkspace的动态状态缓存。
    查询失败向采集器传播并由其标记未知；无匹配窗口返回(None, None)。
    本函数只读窗口元信息，图片保存、隐私门禁和模型调用由原协作者负责。
    """
    if display is None:
        return application_for_pid(frontmost_pid())
    import Quartz
    windows = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID)
    if windows is None:
        raise RuntimeError('系统窗口列表读取失败，应用身份保持未知')
    for pid in display_window_pids(windows, display):
        app, bundle = application_for_pid(pid)
        if app:
            return app, bundle
    return None, None
