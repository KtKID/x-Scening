"""项目文件日志与终端进度；时间与事件来源保持一致。"""
from datetime import datetime
import json
import os
from pathlib import Path
import threading

# 桌面publish进程指定用户日志目录；源码运行默认沿用项目logs。
LOG_PATH = (
    Path(os.environ['SCENING_LOG_DIR']).expanduser()
    if os.environ.get('SCENING_LOG_DIR')
    else Path(__file__).resolve().parents[2] / 'logs'
) / 'x-scening.log'
_LOG_LOCK = threading.Lock()


def initialize_logging() -> None:
    """创建项目 logs 并检查追加能力；失败抛出 OSError，调用者应结束本次运行。"""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8"):
        pass


def format_console_event(entry: dict) -> str:
    """把已写入文件的事件转换为终端中文进度。

    时间复用事件的秒级时间，路径复用实际保存结果，stdout与文件可逐项对应。
    成功候选打印正式 JPEG；模型只展示开始/保存状态，正文由活动和总结文件承载。
    返回完整文本供一次print并flush，兼容终端、zellij和stdout管道。
    """
    stage, result = entry.get("stage"), entry.get("result")
    if stage == "image_prepare" and result == "saved":
        messages = [f"候选 JPEG 已保存：{entry.get('screenshot')}；原分辨率 {entry.get('originalSize')}；屏幕 {entry.get('display')}"]
    elif stage == "capture" and result == "started":
        messages = [f"开始截图（第 {entry.get('round')} 轮）"]
    elif stage == "candidate" and result == "started":
        messages = [f"开始处理候选（第 {entry.get('round')} 轮，采集于 {entry.get('capturedAt')}）"]
    elif stage == "analysis" and result == "started":
        messages = [f"KMH 分析中：{entry.get('mini')}"]
    elif stage == "analysis_batch" and result == "pending":
        messages = [f"分析待凑图：{entry.get('pendingCount')}/{entry.get('batchSize')}"]
    elif stage == "analysis_batch" and result == "incomplete":
        messages = [f"未满批原图已保留：{entry.get('pendingCount')}/{entry.get('batchSize')}；{entry.get('message')}"]
    elif stage == "analysis_batch" and result == "saved":
        messages = [f"{entry.get('frameCount')} 帧拼图已保存：{entry.get('screenshot')}；尺寸 {entry.get('size')}"]
    elif stage == "activity" and result == "appended":
        messages = [f"KMH 分析完成，记录已保存：{entry.get('records')}"]
    elif stage == "activity" and result == "extended":
        messages = [f"画面相同，已更新末条 end：{entry.get('end')}"]
    elif stage == "summary" and result == "started":
        messages = [f"总结生成中：{entry.get('windowStart')} ～ {entry.get('windowEnd')}"]
    elif stage == "summary" and result == "saved":
        messages = [f"总结已保存：{entry.get('summary')}"]
    elif stage == "summary" and result == "empty":
        messages = [f"总结窗口暂无活动：{entry.get('windowStart')} ～ {entry.get('windowEnd')}"]
    elif stage in ("observer", "activity_observer") and result == "started":
        messages = [f"观察已启动：{entry.get('scope', '多屏采集')}；最小间隔 {entry.get('intervalSeconds')} 秒；home={entry.get('home')}"]
    elif stage in ("observer", "activity_observer") and result == "stopped":
        messages = [f"观察已停止：尝试 {entry.get('attempts')} 轮，失败 {entry.get('failures')} 轮"]
    else:
        labels = {"requesting": "申请权限中", "waiting": "等待授权", "granted": "已获授权", "failed": "失败", "unknown": "信息待确认"}
        messages = [f"{stage}：{labels.get(result, result)} {entry.get('message', '')}".rstrip()]
        for key in ("screenshot", "mini"):
            if entry.get(key):
                messages.append(f"{key} 目标路径：{entry[key]}")
    return "\n".join(f"[{entry['time']}] {message}" for message in messages)


def log_event(event: dict) -> None:
    """追加一行带本地秒级时间的JSON日志，再即时打印终端进度。

    event 提供阶段、结果、已知文件和原因等字段，供人工核对实际执行过程。
    文件写入成功并关闭后才打印同一事件，flush保证等待模型时进度已可见。
    OSError交给调用者处理；文件写入失败时终端保持失败语义，由原错误入口反馈。
    """
    entry = {"time": datetime.now().astimezone().isoformat(timespec="seconds"), **event}
    with _LOG_LOCK:
        with LOG_PATH.open("a", encoding="utf-8") as log:
            log.write(json.dumps(entry, ensure_ascii=False) + "\n")
        print(format_console_event(entry), flush=True)
