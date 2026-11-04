"""报告派生的同日分析队列；实时与手动入口共用处理锁和原图恢复。"""
from contextlib import contextmanager
from datetime import datetime
import fcntl
import hashlib
import re
import time
from PIL import Image
from scening.activity_evidence import EvidenceStore
from scening.activity_memory import ActivityFrame, ActivityMemory
from scening.analysis_batch import BatchFrame
from scening.capture_metadata import metadata_path, read_capture
from scening.frame_store import PreparedImage
from scening.runtime_control import AnalysisCancelled
from scening.screenshot_index import rebuild_day
from scening.sensitive_guard import SensitiveGuard
from scening.task_store import day_key, digest, read_activities


def analysis_lock_path(config, day):
    """同日所有图片模型处理的唯一锁位置，按home隔离。"""
    return config.home / 'analysis-queue' / (day_key(day) + '.lock')


@contextmanager
def analysis_lock(config, day, *, cancel_event=None, wait=False):
    """取得跨进程同日锁；wait沿配置轮询并可取消，实时入口忙时返回False。

    锁覆盖选最早图片、模型与报告提交；采集线程和索引锁独立，持续保存JPEG。
    所有退出路径释放；锁文件可保留，持有状态由flock判定。
    """
    path = analysis_lock_path(config, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as lock:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise AnalysisCancelled('分析队列等待已取消')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not wait:
                    yield False
                    return
                if cancel_event is None:
                    import time
                    time.sleep(config.control.pollSeconds)
                else:
                    cancel_event.wait(config.control.pollSeconds)
        yield True


def pending_images(config, day, *, exclude=()):
    """重建索引并按采集时间返回待分析图；exclude仅为当前运行已消费的合并批。"""
    excluded = set(exclude)
    items = [item for item in rebuild_day(config, day)['images'] if not item['analyzed'] and item['file'] not in excluded]
    def order(item):
        metadata = read_capture(config, config.screenshotDir / item['file'])
        at = metadata.capturedAt if metadata else datetime.fromisoformat(item['capturedAt']).astimezone()
        return at.timestamp(), item['file']
    return sorted(items, key=order)


def legacy_samples(config, day):
    """从有效签名的旧采样恢复系统身份；旧图缺失依据保持未知。"""
    records, _ = read_activities(config.home, day)
    by_id = {row['id']: row for row in records}
    try:
        evidence, issues = EvidenceStore(config.home).read_partial(day)
    except (OSError, ValueError) as error:
        return {}, ['历史采样依据无法读取，应用保持未知：' + type(error).__name__]
    samples = {}
    for sample in evidence.samples:
        row = by_id.get(sample.activityId)
        if row and row['signature'] == sample.sourceSignature:
            samples.setdefault((sample.capturedAt[:19], sample.screen), []).append(sample)
    return samples, issues


def load_frame(config, item, samples):
    """读取完整JPEG和采集事实，返回BatchFrame及原图SHA256；旧图按有效采样回退。

    先校验允许根、文件名时间/屏幕，再读取旁文件或旧采样；二者缺失时应用未知。
    只读原图与采集依据，图片失败传播，正式引用沿Memory校验上下文。
    """
    root = config.screenshotDir.resolve()
    path = (root / item['file']).resolve()
    if not path.is_relative_to(root):
        raise ValueError('原图超出截图目录')
    matched = re.search(r'_m([1-9]\d*)_', path.name)
    if matched is None:
        raise ValueError('原图屏幕编号无效')
    screen = int(matched[1])
    at = datetime.fromisoformat(item['capturedAt']).astimezone()
    metadata = read_capture(config, path)
    sample = next((s for s in samples.get((item['capturedAt'][:19], screen), [])
                   if s.sampleId == digest([str(path), s.capturedAt])), None)
    app = bundle_id = None
    if metadata is not None:
        at, app, bundle_id = metadata.capturedAt, metadata.app, metadata.bundleId
    elif sample is not None:
        at, app, bundle_id = datetime.fromisoformat(sample.capturedAt), sample.app, sample.bundleId
    with Image.open(path) as image:
        image.load()
        size = image.size
    memory = ActivityMemory(config.home, screenshot_dir=config.screenshotDir)
    evidence = ActivityFrame.model_validate({'capturedAt': at, 'screenshot': memory.image_reference(path),
                                            'app': app, 'bundleId': bundle_id, 'screen': screen},
                                           context=memory.validation_context)
    return BatchFrame(PreparedImage(path, path, size, size), evidence), hashlib.sha256(path.read_bytes()).hexdigest()


def load_analysis_frame(config, item, samples, *, cancel_event=None):
    """读取待分析原图，复用采集端隐私闸门；敏感图删除后返回None。

    参数与load_frame一致，cancel_event用于取消本次处理；调用方持同日分析锁，
    且item已按最新报告核对为待分析。允许帧返回(BatchFrame, SHA256)。
    SensitiveGuard.evaluate继续独占应用黑名单、原生OCR及内容规则；OCR失败
    转为RuntimeError，保留图片和采集信息供现有队列退避或手动继续时重试。
    确认命中应用或内容后先删除JPEG、再删除同名metadata，最后重建日期索引。
    JPEG删除失败时采集身份保持完整；后续清理或索引失败传播，并刷新可重建索引。
    取消在读取前和闸门返回后核对，取消后的文件保持原值。
    """
    def check_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise AnalysisCancelled('积压隐私检查已取消')

    check_cancelled()
    frame, source_hash = load_frame(config, item, samples)
    if config.privacy is None:
        return frame, source_hash
    verdict = SensitiveGuard(config.privacy).evaluate(
        frame.image.original, app=frame.evidence.app, bundle_id=frame.evidence.bundleId)
    check_cancelled()
    if not verdict.blocked:
        return frame, source_hash
    if verdict.reason not in ('app', 'content'):
        raise RuntimeError('本地OCR检查失败，原图保留待重试')
    try:
        frame.image.original.unlink()
        metadata_path(frame.image.original).unlink(missing_ok=True)
    finally:
        rebuild_day(config, frame.evidence.capturedAt.date().isoformat())
    return None


class ScreenshotQueue:
    """单个分析开启段的日队列；积压先完成，新图沿用实时满批和无变化规则。"""
    def __init__(self, config, day, *, backlog=None):
        self.config, self.day = config, day_key(day)
        self.needs_snapshot = False
        if backlog is None:
            try:
                backlog = pending_images(config, day)
            except (OSError, ValueError):
                backlog = []
                self.needs_snapshot = True
        self.backlog = {i['file'] for i in backlog}
        self.handled = set()
        self.failed = set()
        self.failed_attempts = 0
        self.retry_deadline = 0.0
        self.waiting = ()
        self.waiting_at = None

    def rescan_backlog(self):
        """候选通知溢出后把仍未消费的正式原图转为积压，按时间完整补回。"""
        self.backlog.update(item['file'] for item in pending_images(self.config, self.day, exclude=self.handled))

    def finish(self, pipeline, reason):
        """结束本段时显式记录实时未满批；原图与采集事实继续由正式目录保留。"""
        if self.waiting:
            pipeline.report_pending(len(self.waiting), self.waiting_at, reason=reason)
            self.waiting = ()

    def retry_hint(self):
        """失败后的恢复方式提示；未达重试上限说明自动重试，达上限提示人工介入。"""
        analysis = self.config.analysis
        if self.failed and self.failed_attempts <= analysis.maxRetries:
            wait = self.failed_attempts * analysis.retryIntervalSeconds
            return (f'{wait:g}秒后自动重试同批'
                    f'（已连续失败{self.failed_attempts}次，重试上限{analysis.maxRetries}次）')
        return '重新开启分析或手动补齐失败批后继续'

    def step(self, pipeline, *, cancel_event=None):
        """尝试消费最早一批；返回busy/blocked/waiting_retry/waiting或公开批分析结果。

        失败批按线性递增退避自动重试：第n次重试等待n*retryIntervalSeconds；
        自动重试达maxRetries次仍失败进入blocked并阻止自动越过，重新开启或
        其他入口补齐后恢复；锁内重新核对正式frames。已成功无变化合并仅在
        当前段去重，跨段重新按报告核对。
        """
        with analysis_lock(self.config, self.day, cancel_event=cancel_event) as acquired:
            if not acquired:
                return 'busy'
            pending = pending_images(self.config, self.day, exclude=self.handled)
            known = {item['file'] for item in pending}
            if self.needs_snapshot:
                self.backlog = set(known)
                self.needs_snapshot = False
            self.backlog.intersection_update(known)
            self.failed.intersection_update(known)
            if self.failed:
                if self.failed_attempts > self.config.analysis.maxRetries:
                    return 'blocked'
                if time.monotonic() < self.retry_deadline:
                    return 'waiting_retry'
                # 退避窗口结束：清失败标记并按最早顺序重试同批，期间不跳过后续批次。
                self.failed.clear()
                self.retry_deadline = 0.0
            old = [i for i in pending if i['file'] in self.backlog]
            if not old:
                # 实时未满批跨采集中断时保留原图，和原候选入口的reset语义一致。
                while pending:
                    first_meta = read_capture(self.config, self.config.screenshotDir / pending[0]['file'])
                    group = (first_meta.runId, first_meta.generation) if first_meta else None
                    prefix = []
                    for item in pending:
                        meta = read_capture(self.config, self.config.screenshotDir / item['file'])
                        current = (meta.runId, meta.generation) if meta else None
                        if current != group:
                            break
                        prefix.append(item)
                    if len(prefix) >= self.config.analysis.batchSize or len(prefix) == len(pending):
                        pending = prefix
                        break
                    self.handled.update(item['file'] for item in prefix)
                    pipeline.report_pending(len(prefix), prefix[-1]['capturedAt'], reason='采集中断，未满批原图保留')
                    pipeline.reset('实时未满批遇到采集中断，原图保留')
                    pending = pending[len(prefix):]
            selected = (old or pending)[:self.config.analysis.batchSize]
            force = bool(old)
            if not selected or (not force and len(selected) < self.config.analysis.batchSize):
                files = tuple(item['file'] for item in selected)
                if files and files != self.waiting:
                    pipeline.report_pending(len(selected), selected[-1]['capturedAt'])
                self.waiting = files
                self.waiting_at = selected[-1]['capturedAt'] if selected else None
                return 'waiting'
            self.waiting = ()
            try:
                samples, _ = legacy_samples(self.config, self.day)
                frames = []
                for item in selected:
                    checked = load_analysis_frame(self.config, item, samples, cancel_event=cancel_event)
                    if checked is not None:
                        frames.append(checked[0])
                removed = len(selected) - len(frames)
                if removed:
                    pipeline.reset('敏感积压图已删除，重新建立活动基准')
                points = {}
                for frame in frames:
                    path = frame.image.original
                    metadata = read_capture(self.config, path)
                    if metadata is not None and metadata.sampleSequence is not None:
                        at = metadata.capturedAt.isoformat()
                        points[str(path)] = {'sampleId': digest([str(path), at]), 'capturedAt': at,
                            'runId': metadata.runId, 'continuityId': metadata.runId + ':' + str(metadata.generation),
                            'sampleSequence': metadata.sampleSequence, 'app': metadata.app,
                            'bundleId': metadata.bundleId, 'screen': metadata.screen}
                result = (pipeline.process_batch(frames, force=force or bool(removed),
                          allow_partial=force or bool(removed), samples=points)
                          if frames else 'privacy_blocked')
                self.handled.update(item['file'] for item in selected)
                self.backlog.difference_update(self.handled)
                self.failed_attempts = 0
                return result
            except AnalysisCancelled:
                raise
            except Exception:
                self.failed.update(item['file'] for item in selected)
                self.failed_attempts += 1
                if self.failed_attempts <= self.config.analysis.maxRetries:
                    self.retry_deadline = (time.monotonic()
                                           + self.failed_attempts * self.config.analysis.retryIntervalSeconds)
                raise
