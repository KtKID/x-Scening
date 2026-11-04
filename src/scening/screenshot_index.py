"""按日期扫描正式原图，以活动报告 frames 为唯一依据重建可丢弃索引。"""
import argparse
from datetime import date, datetime
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from scening.activity_memory import EVENT_LIST
from scening.observer_config import DEFAULT_CONFIG_PATH, load_config

# 正式原图的既有文件格式；事件临时目录和派生 batch 图各自独立。
ORIGINAL_NAME = re.compile(r'^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_m[1-9]\d*_[A-Za-z0-9_-]+\.jpg$')


def _day_key(day):
    """验证完整日历日期，返回可用于单级目录的日期字符串。"""
    if date.fromisoformat(day).isoformat() != day:
        raise ValueError('日期应为 YYYY-MM-DD')
    return day


def _report_references(home, day, root):
    """严格读取当天报告，返回规范化原图路径集合及可见诊断。

    home 为活动根，root 为截图根。报告缺失表示当天尚无分析结果；JSON、结构、
    日期或引用语法错误抛 ValueError/OSError，调用方保留旧索引。顶层拼图路径
    只用于报告结构验证，分析依据仅取 frames；历史单图记录显式列为诊断。
    本函数只读报告，原文与未知扩展字段保持原值。
    """
    path = home / 'records' / f'{day}.json'
    try:
        raw = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return set(), []
    records = EVENT_LIST.validate_python(json.loads(raw), context={'allow_absolute_images': True})
    references, issues = set(), []
    for number, record in enumerate(records, 1):
        if record.start.date().isoformat() != day:
            raise ValueError(f'报告第 {number} 条日期与文件名不符')
        if not record.frames:
            issues.append(f'报告第 {number} 条缺少 frames，保留该条原图分析状态待核对')
        for frame in record.frames or []:
            if frame.capturedAt.date().isoformat() != day:
                raise ValueError(f'报告第 {number} 条原图日期与报告日期不符')
            reference = Path(frame.screenshot)
            resolved = (reference if reference.is_absolute() else home / reference).resolve()
            if not resolved.is_relative_to(root):
                issues.append(f'报告第 {number} 条原图位于当前截图目录外：{reference.name}')
                continue
            references.add(resolved)
            if not resolved.is_file():
                issues.append(f'报告原图缺失：{resolved.relative_to(root).as_posix()}')
    return references, sorted(set(issues))


def _originals(root, day, directory):
    """扫描日期目录和旧平铺目录的正式 JPEG，返回时间、相对路径和解析路径。

    时间由既有文件名中的采集时间恢复，精度为秒，时区按文件名原义保持未指定。
    仅枚举两级明确目录，临时事件、派生拼图和其他日期保持排除；目录读取失败、
    不合法时间或越界符号链接传播错误。文件保持原位置和原名。
    """
    originals = []
    for folder in (root, directory):
        for path in folder.iterdir():
            matched = ORIGINAL_NAME.fullmatch(path.name)
            if not matched or matched[1] != day:
                continue
            at = datetime.strptime(matched[1] + '_' + matched[2], '%Y-%m-%d_%H-%M-%S')
            resolved = path.resolve()
            if not resolved.is_relative_to(root):
                raise ValueError('原图引用超出截图目录：' + path.name)
            if path.is_file():
                originals.append((at.isoformat(), path.relative_to(root).as_posix(), resolved))
    return sorted(originals, key=lambda item: (item[0], item[1]))


def rebuild_day(config, day):
    """重建并原子保存单日 index.json，返回本次保存的对象。

    config 提供 home/screenshotDir，day 为 YYYY-MM-DD。日期目录先建立，随后持有
    本日文件锁，再读取最新报告与原图；索引从零推导，旧索引内容始终保持旁路。
    写入同目录临时文件、刷新后原子替换，任何读取/编码/替换错误保留旧索引；
    最后清理临时文件并释放锁。仅写派生 index.json 与其 .index.lock。
    """
    day = _day_key(day)
    root, home = Path(config.screenshotDir).resolve(), Path(config.home).resolve()
    directory = root / day
    if directory.resolve().parent != root:
        raise ValueError('日期目录超出截图根目录')
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.index.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        references, issues = _report_references(home, day, root)
        images = [{'file': name, 'capturedAt': at, 'analyzed': path in references}
                  for at, name, path in _originals(root, day, directory)]
        result = {'schemaVersion': 1, 'date': day, 'timeBasis': 'filename_capture_time',
                  'images': images, 'issues': issues}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory,
                                             prefix='.index-', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, directory / 'index.json')
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return result


def main(argv=None):
    """独立本地重建命令：成功返回 0，参数/来源错误返回 1 并说明原因。

    命令读取既有配置和报告，输出索引位置与数量；采集及模型调用保持关闭。
    """
    parser = argparse.ArgumentParser(description='根据分析报告 frames 重建单日截图 index.json')
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument('--home', type=Path)
    parser.add_argument('--screenshot-dir', type=Path)
    parser.add_argument('--day', required=True)
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config, home=args.home, screenshotDir=args.screenshot_dir)
        result = rebuild_day(config, args.day)
        analyzed = sum(item['analyzed'] for item in result['images'])
        print(json.dumps({'index': str(config.screenshotDir / args.day / 'index.json'),
                          'total': len(result['images']), 'analyzed': analyzed,
                          'unanalyzed': len(result['images']) - analyzed,
                          'issues': result['issues']}, ensure_ascii=False))
        return 0
    except (OSError, ValueError) as error:
        print('截图索引重建失败：' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
