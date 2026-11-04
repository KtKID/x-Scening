"""桌面补分析公开状态；正式报告frames决定数量，运行锁决定实时作业状态。"""
import argparse
from datetime import date, datetime
import fcntl
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from scening.observer_config import DEFAULT_CONFIG_PATH, load_config
from scening.screenshot_index import rebuild_day
from scening.task_store import day_key
from scening.screenshot_queue import analysis_lock_path


class BackfillStatus(BaseModel):
    """Python拥有的桌面查询回复；数量为空表示来源核对失败，完成状态由报告推导。"""
    model_config = ConfigDict(extra='forbid')
    day: str
    state: Literal['idle', 'running', 'completed', 'partial', 'cancelled', 'failed', 'empty', 'error']
    total: Optional[int] = Field(ge=0)
    analyzed: Optional[int] = Field(ge=0)
    remaining: Optional[int] = Field(ge=0)
    eligible: bool
    planned: int = Field(default=0, ge=0)
    processed: int = Field(default=0, ge=0)
    message: str = ''
    activeDay: Optional[str] = None
    owned: bool = False


class _Progress(BaseModel):
    """仅消费既有进度文件中的展示字段；其余运行证据继续归补跑程序管理。"""
    model_config = ConfigDict(extra='ignore')
    day: str
    state: Literal['running', 'completed', 'partial', 'cancelled', 'failed']
    planned: int = Field(ge=0)
    processed: int = Field(ge=0)


def _locked(path):
    """探测既有同日作业锁并立即释放；缺失表示尚无作业，其他IO错误传播。"""
    try:
        lock = path.open('r+')
    except FileNotFoundError:
        return False
    with lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def read_backfill_status(config, day):
    """核对指定日期并返回公开回复，整个入口保持零模型调用。

    参数为启动配置和真实日期。先重建派生索引，再读取可丢弃进度、探测作业锁；
    完成判定始终依照最新原图和报告frames。坏进度忽略，坏报告/IO返回error及空数量。
    本函数只写可重建index，原图、正式报告、作业进度均保持原值。
    """
    day_key(day)
    eligible = date.fromisoformat(day) <= datetime.now().astimezone().date()
    try:
        index = rebuild_day(config, day)
        total = len(index['images'])
        remaining = sum(not item['analyzed'] for item in index['images'])
        folder = config.home / 'backfill' / day
        progress = None
        try:
            progress = _Progress.model_validate_json((folder / 'latest.json').read_text())
            if progress.day != day:
                progress = None
        except (OSError, ValueError):
            pass
        manual_running = _locked(folder / '.run.lock')
        automatic_running = _locked(analysis_lock_path(config, day)) and not manual_running
        state = 'idle'
        if manual_running or automatic_running:
            state = 'running'
        elif total == 0:
            state = 'empty'
        elif remaining == 0:
            state = 'completed'
        elif progress and progress.state in ('partial', 'cancelled', 'failed'):
            state = progress.state
        message = {
            'idle': '点击开始，应用会自动补齐待分析截图。',
            'running': '正在补分析，成功结果会自动保存。',
            'empty': '这一天暂无截图。',
            'completed': '这一天的截图已全部分析。',
            'partial': '部分截图处理失败，可继续补分析剩余截图。',
            'cancelled': '补分析已停止，已保存结果保留。',
            'failed': '上次补分析中断，可继续处理剩余截图。',
        }[state]
        if automatic_running:
            message = '应用正在按时间顺序分析这一天的截图，积压完成后接续新图。'
        if not eligible and remaining > 0 and state == 'idle':
            message = '该日期尚未开始，请选择今天或更早日期。'
        if index['issues']:
            message += f" 有{len(index['issues'])}项来源提示，详情见当天截图索引。"
        return BackfillStatus(day=day, state=state, total=total, analyzed=total-remaining,
                              remaining=remaining, eligible=eligible, message=message,
                              planned=progress.planned if progress and not automatic_running else 0,
                              processed=progress.processed if progress and not automatic_running else 0)
    except (OSError, ValueError):
        return BackfillStatus(day=day, state='error', total=None, analyzed=None, remaining=None,
                              eligible=eligible, message='核对失败，请检查当天报告和截图目录后重试。')


def main():
    """只进行本地核对的CLI；边界模型校验后输出单份JSON回复。"""
    parser = argparse.ArgumentParser(description='核对指定日期截图分析状态')
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument('--day', required=True)
    args = parser.parse_args()
    reply = read_backfill_status(load_config(args.config), args.day)
    print(reply.model_dump_json())


if __name__ == '__main__':
    main()
