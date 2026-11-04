"""补分析今天及历史日期原图；与实时队列共用日锁，报告frames保持唯一成功依据。"""
import argparse
from datetime import date, datetime
import fcntl
import json
from pathlib import Path
import signal
import tempfile
import threading
from uuid import uuid4

from scening.activity_memory import ActivityMemory, EVENT_LIST, captured_app_names, observation_text
from scening.analysis_batch import compose_batch, frame_metadata
from scening.kmh_interpreter import KMHInterpreter
from scening.observation_generated import ObservationResult
from scening.observer_config import DEFAULT_CONFIG_PATH, load_config
from scening.runtime_control import AnalysisCancelled, SignalCancellation
from scening.screenshot_index import rebuild_day
from scening.screenshot_queue import analysis_lock, legacy_samples, load_analysis_frame, pending_images
from scening.task_store import day_key


def _save_json(path, value):
    """完整写入同目录临时文件后原子发布进度；失败清理临时文件并传播。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        temporary.replace(path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def _records(home, day):
    """只读已公开的每日记录契约，保留原数组顺序和未知扩展字段。"""
    path = home / 'records' / f'{day}.json'
    if not path.exists():
        return []
    rows = json.loads(path.read_text())
    EVENT_LIST.validate_python(rows, context={'allow_absolute_images': True})
    return rows


_sample_metadata = legacy_samples
_frame = load_analysis_frame


def backfill_day(config, day, *, interpreter=None, cancel_event=None, on_progress=None):
    """按时间补跑今天或历史日期，返回运行进度与剩余清单。

    config为启动快照，day为真实日期；interpreter仅用于模型边界替身，cancel_event取消本轮。
    作业锁覆盖完整手动任务，处理锁逐批覆盖选图、模型与提交，和实时入口协调。
    保存顺序为运行清单/报告备份、拼图、模型结果、原报告追加、索引刷新、进度发布。
    建帧复用自动积压的隐私检查：确认敏感删除原图与采集信息、刷新索引；
    OCR失败保留待重试并记录逐帧错误。每批模型或图片异常保留其余原图，
    继续后续批次；坏报告、来源前缀变化和锁忙传播异常。
    当天允许实时采集继续保存；每批锁内复核来源与原报告前缀，未来日期拒绝。
    """
    day_key(day)
    if date.fromisoformat(day) > datetime.now().astimezone().date():
        raise ValueError('补分析日期应为今天或历史日期')
    home = config.home.resolve()
    folder = home / 'backfill' / day
    folder.mkdir(parents=True, exist_ok=True)
    event = cancel_event or threading.Event()
    model = interpreter or KMHInterpreter(home, config=config, cancel_event=event)
    memory = ActivityMemory(home, screenshot_dir=config.screenshotDir)
    with (folder / '.run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        initial = rebuild_day(config, day)
        pending = pending_images(config, day)
        originals = _records(home, day)
        run = folder / (datetime.now().astimezone().strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex[:8])
        run.mkdir()
        _save_json(run / 'initial-images.json', pending)
        _save_json(run / 'original-records.json', originals)
        samples, metadata_issues = _sample_metadata(config, day)
        result = {'day': day, 'state': 'running', 'planned': len(pending), 'processed': 0,
                  'skipped': 0, 'remaining': len(pending), 'modelCalls': 0, 'batches': 0,
                  'privacyBlocked': 0,
                  'errors': [], 'issues': initial['issues'] + metadata_issues,
                  'startedAt': datetime.now().astimezone().isoformat(),
                  'runDirectory': str(run.relative_to(home)), 'sourceHashes': {}}

        def publish():
            """从最新报告引用核对剩余量，原子保存本轮与日期级进度，并发送回调。"""
            index = rebuild_day(config, day)
            referenced = {item['file'] for item in index['images'] if item['analyzed']}
            present = {item['file'] for item in index['images']}
            result['remainingFiles'] = [item['file'] for item in pending
                                        if item['file'] in present and item['file'] not in referenced]
            result['remaining'] = len(result['remainingFiles'])
            result['allDateRemaining'] = sum(not item['analyzed'] for item in index['images'])
            result['updatedAt'] = datetime.now().astimezone().isoformat()
            _save_json(run / 'progress.json', result)
            _save_json(folder / 'latest.json', result)
            if on_progress:
                on_progress(dict(result))

        publish()
        queue = list(pending)
        try:
            while queue and not event.is_set():
                with analysis_lock(config, day, cancel_event=event, wait=True):
                    index = rebuild_day(config, day)
                    referenced = {item['file'] for item in index['images'] if item['analyzed']}
                    selected, queue = queue[:config.analysis.batchSize], queue[config.analysis.batchSize:]
                    fresh = [item for item in selected if item['file'] not in referenced]
                    result['skipped'] += len(selected) - len(fresh)
                    if not fresh:
                        continue
                    before_batch = _records(home, day)
                    frames = []
                    accepted = []
                    for item in fresh:
                        try:
                            checked = _frame(config, item, samples, cancel_event=event)
                            if checked is None:
                                result['privacyBlocked'] += 1
                                continue
                            frame, source_hash = checked
                            frames.append(frame)
                            accepted.append(item)
                            result['sourceHashes'][item['file']] = source_hash
                        except AnalysisCancelled:
                            raise
                        except (OSError, ValueError, RuntimeError) as error:
                            result['errors'].append({'files': [item['file']], 'error': f'{type(error).__name__}：{error}'})
                    fresh = accepted
                    if not frames:
                        publish()
                        continue
                    frames.sort(key=lambda frame: frame.evidence.capturedAt)
                    try:
                        if event.is_set():
                            raise AnalysisCancelled('补分析已取消')
                        collage = compose_batch(frames, home, config.analysis, allow_partial=True)
                        result['modelCalls'] += 1
                        observation = model.analyze(collage.mini, frames=frame_metadata(frames))
                        if event.is_set():
                            raise AnalysisCancelled('补分析已取消')
                        index = rebuild_day(config, day)
                        referenced = {item['file'] for item in index['images'] if item['analyzed']}
                        survivors = [item for item in fresh if item['file'] not in referenced]
                        if len(survivors) != len(fresh):
                            result['skipped'] += len(fresh) - len(survivors)
                            queue = survivors + queue
                            continue
                        if _records(home, day)[:len(before_batch)] != before_batch:
                            raise ValueError('原始报告前缀已变化，补跑停止以保留活动身份')
                        structured = observation if isinstance(observation, ObservationResult) else None
                        first, last = frames[0].evidence, frames[-1].evidence
                        same_app = all((f.evidence.app, f.evidence.bundleId) == (first.app, first.bundleId) for f in frames)
                        record = {'start': first.capturedAt.isoformat(timespec='seconds'),
                                  'end': last.capturedAt.isoformat(timespec='seconds'),
                                  'app': '、'.join(captured_app_names({'frames': [f.evidence.model_dump(mode='json') for f in frames]})),
                                  'bundleId': first.bundleId if same_app else None,
                                  'analysis': observation_text(structured) if structured else observation,
                                  'source': 'screen', 'screenshot': memory.image_reference(collage.original),
                                  'mini': memory.image_reference(collage.mini),
                                  'frames': [f.evidence.model_dump(mode='json') for f in frames]}
                        if structured:
                            record['observation'] = structured.model_dump(mode='json')
                        memory.append(record)
                        result['processed'] += len(frames)
                        result['batches'] += 1
                        _save_json(run / f"batch-{result['batches']:04d}.json", record)
                    except AnalysisCancelled:
                        event.set()
                        break
                    except (RuntimeError, OSError, ValueError) as error:
                        result['errors'].append({'files': [item['file'] for item in fresh], 'error': f'{type(error).__name__}：{error}'})
                        if '原始报告前缀已变化' in str(error):
                            raise
                    publish()
            result['state'] = 'cancelled' if event.is_set() else 'completed'
        except AnalysisCancelled:
            event.set()
            result['state'] = 'cancelled'
        except BaseException:
            result['state'] = 'failed'
            raise
        finally:
            result['finishedAt'] = datetime.now().astimezone().isoformat()
            publish()
        if (result['remaining'] or result['errors']) and result['state'] == 'completed':
            result['state'] = 'partial'
            publish()
        return result


def main():
    """扫描或执行历史补跑CLI；SIGINT/SIGTERM取消当前模型并保留成功报告。"""
    parser = argparse.ArgumentParser(description='根据截图索引补分析今天或历史日期')
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument('--day', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    config = load_config(args.config)
    if not args.execute:
        index = rebuild_day(config, args.day)
        print(json.dumps({'day': args.day, 'total': len(index['images']),
                          'remaining': sum(not item['analyzed'] for item in index['images'])}, ensure_ascii=False))
        return
    event = SignalCancellation()
    model = KMHInterpreter(config.home, config=config, cancel_event=event)
    signal.signal(signal.SIGINT, event.set)
    signal.signal(signal.SIGTERM, event.set)

    def progress(result):
        print(json.dumps({key: result[key] for key in ('day', 'state', 'planned', 'processed', 'remaining', 'modelCalls', 'batches', 'updatedAt')}, ensure_ascii=False), flush=True)

    result = backfill_day(config, args.day, interpreter=model, cancel_event=event, on_progress=progress)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if result['remaining']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
