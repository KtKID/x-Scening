"""采集策略：多屏缓存、事件首尾、分段选图和定时观察。

线程独占缓存与事件图；主线程只消费正式候选和状态消息，KMH 可以保持串行。
"""
from __future__ import annotations

from collections import deque
from datetime import datetime
import math
from queue import Empty, Full, Queue
import threading
import time
from uuid import uuid4

from scening.capture import Frame, NativeBackend, display_at
from scening.frame_store import BufferedFrame, Candidate, FrameStore
from scening.selection import Action, segment_actions
from scening.sensitive_guard import SensitiveGuard
from scening.screenshot_index import rebuild_day
from scening.capture_metadata import save_capture


class SensingCollector:
    """运行一个采集段，公开候选消费、状态读取、停止与确定性单轮回放接口。"""

    def __init__(self, config, *, backend=None, app_provider=None,
                 clock=time.monotonic, wall_clock=None):
        self.config = config
        self.settings = config.scening
        self.backend = backend if backend is not None else NativeBackend(min(self.settings.shutdownTimeoutSeconds,config.control.timeoutSeconds))
        if app_provider is None:
            from scening.app_identity import frontmost_application
            app_provider = frontmost_application
        self.app_provider = app_provider
        self.clock = clock
        self.wall_clock = wall_clock or (lambda: datetime.now().astimezone())
        self.store = FrameStore(config.screenshotDir, self.settings.jpegQuality)
        # 隐私闸门：privacy块缺失或关闭时为None，行为与未接入一致
        self.guard = SensitiveGuard(config.privacy) if config.privacy is not None else None
        self.candidates = Queue(maxsize=self.settings.candidateQueueSize)
        self._events = Queue(maxsize=self.settings.maxStoredActions)
        self._statuses = deque(maxlen=self.settings.maxStoredActions)
        self._status_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._fatal = None
        self._closed = False
        self._displays = []
        self._frames = {}
        self._last_monitor = None
        self._last_refresh = None
        self._next_action = None
        self._next_observation = None
        self._last_emitted = None
        self._actions = []
        self._raw_events = 0
        self._click = self._keyboard = self._scroll = None
        self._last_scroll = None
        self._scroll_started = None
        self._scroll_count = 0
        self._paused = False
        self._capture_error = None
        self._dropped_events = 0
        self._started_at = clock()
        self.total_frames = 0
        self._generation = 0
        self._sample_sequence = 0
        self.run_id = str(uuid4())

    def _status(self, result, message, **fields):
        """把线程状态放入有界日志缓冲；日志文件的写入由主线程负责。"""
        if fields.get('discontinuity'):
            self._generation += 1
        entry = {'stage': 'scening', 'result': result, 'message': message,
                 'at': self.wall_clock().isoformat(), **fields}
        with self._status_lock:
            self._statuses.append(entry)

    def drain_status(self):
        """取走当前状态消息；每条包含发生时间，主线程据此处理活动中断。"""
        with self._status_lock:
            result = list(self._statuses)
            self._statuses.clear()
        return result

    @property
    def capture_fps(self):
        """按严格宽高条件选择缓存更新目标频率。"""
        high = any(d.width > self.settings.highResolutionWidth or
                   d.height > self.settings.highResolutionHeight for d in self._displays)
        return self.settings.highResolutionFps if high else self.settings.captureFps

    def submit_event(self, event):
        """监听回调只入队，过载次数交给下一采集轮记录；具体键值保持在监听器内。"""
        try:
            self._events.put_nowait(event)
        except Full:
            self._dropped_events += 1

    def start(self):
        """启动独立采集线程；调用方持有本 collector 并负责 close。"""
        if self._thread is not None or self._closed:
            raise RuntimeError('采集段已经启动或关闭')
        self._thread = threading.Thread(target=self._worker, name='scening-capture', daemon=True)
        self._thread.start()
        return self

    def _worker(self):
        """在线程内创建后端资源，退出时关闭；严重异常由消费者获知。"""
        try:
            try:
                listening = self.backend.start_inputs(self.submit_event, self.clock)
                self._status('listening' if listening else 'waiting',
                             '键鼠监听已启动' if listening else '键鼠监听等待输入监控/辅助功能授权，定时观察继续',
                             inputListening=bool(listening))
            except Exception as error:
                self._status('waiting', '输入监听启动失败，定时观察继续：' + str(error), inputListening=False)
            while not self._stop.is_set():
                began = self.clock()
                try:
                    self.tick(began)
                except OSError as error:
                    self._clear_state()
                    self._next_observation = None
                    self._status('round_failed', '本轮采集或保存失败，后续轮次重试：' + str(error), discontinuity=True)
                self._stop.wait(max(0, 1 / self.capture_fps - (self.clock() - began)))
        except BaseException as error:
            self._fatal = error
        finally:
            self._release_resources()

    def _release_resources(self):
        """每个清理阶段独立尝试，后端关闭失败时仍清理事件图和帧缓存。"""
        for cleanup in (self.backend.close, self._clear_state, self._close_frames, self.store.close):
            try:
                cleanup()
            except BaseException as error:
                self._fatal = self._fatal or error

    def _close_frames(self):
        """关闭本线程持有的图像对象并清空缓存。"""
        for frame in self._frames.values():
            frame.image.close()
        self._frames.clear()

    def next_candidate(self, timeout=None):
        """等待一份候选；等待超时返回 None，后台失败或首帧长期失败抛异常。

        timeout 用于主线程检查停止和总结；首帧超时使用已有 captureTimeoutSeconds。
        已发布图片先于返回存在，队列只传路径与采集元信息。
        """
        if self._fatal is not None:
            raise RuntimeError('采集线程失败：' + str(self._fatal)) from self._fatal
        try:
            return self.candidates.get(timeout=timeout)
        except Empty:
            if self._fatal is not None:
                raise RuntimeError('采集线程失败：' + str(self._fatal)) from self._fatal
            if self.total_frames == 0 and self.clock() - self._started_at >= self.config.captureTimeoutSeconds:
                raise TimeoutError('等待第一份有效屏幕候选超时')
            return None

    def _clear_state(self):
        """中断时丢弃待拼接的事件首尾，已发布正式候选保留。"""
        for pending in (self._click, self._keyboard, self._scroll):
            if pending:
                self.store.discard(pending['before'])
        for action in self._actions:
            self.store.discard(action.before)
            self.store.discard(action.after)
        self._click = self._keyboard = self._scroll = None
        self._actions.clear()
        self._raw_events = 0
        self._last_monitor = None
        self._last_scroll = None
        self._scroll_started = None
        self._scroll_count = 0
        while True:
            try:
                self._events.get_nowait()
            except Empty:
                break

    def _refresh(self, now):
        """定时重读屏幕布局；变化时清空旧缓存和跨布局的事件关联。"""
        if self._last_refresh is not None and now - self._last_refresh < self.settings.monitorRefreshSeconds:
            return
        displays = list(self.backend.displays())
        if displays != self._displays:
            changed = bool(self._displays)
            self._clear_state()
            for frame in self._frames.values():
                frame.image.close()
            self._frames.clear()
            self._displays = displays
            self._status('topology_changed' if changed else 'displays',
                         '屏幕布局更新，重建缓存和事件基准',
                         discontinuity=changed, displays=[vars(d) for d in displays])
        self._last_refresh = now

    def _application(self, display):
        """读取目标屏最前方可见普通窗口的应用，读取失败保持未知。"""
        try:
            return self.app_provider(display)
        except Exception:
            return None, None

    def _capture(self):
        """刷新各屏帧；应用在抓屏前后相同才归属，否则标记未知。"""
        failed = []
        for display in self._displays:
            if self._stop.is_set():
                break
            try:
                before = self._application(display)
                at = self.wall_clock()
                image = self.backend.grab(display)
                after = self._application(display)
                if self._stop.is_set():
                    image.close()
                    break
                app, bundle = before if before == after else (None, None)
                frame = Frame(image, at, display, app, bundle)
                previous = self._frames.get(display.index)
                self._frames[display.index] = frame
                if previous:
                    previous.image.close()
                self.total_frames += 1
            except Exception as error:
                previous = self._frames.pop(display.index, None)
                if previous:
                    previous.image.close()
                failed.append((display.index, str(error)))
        failure = str(failed) if failed else None
        if failure != self._capture_error:
            if failure:
                self._clear_state()
            self._status('capture_failed' if failure else 'capture_recovered',
                         failure or '采集恢复', discontinuity=True)
            self._capture_error = failure

    def _finish(self, name):
        """将一个完成的事件转成首尾操作；跨屏消失时清理首图。"""
        pending = getattr(self, name)
        if pending is None:
            return
        frame = self._frames.get(pending['monitor'])
        if frame is not None:
            after = self.store.stage(frame)
            self._actions.append(Action(pending['before'], after, pending['kind']))
            while len(self._actions) > self.settings.maxStoredActions:
                removed = self._actions.pop(0)
                self.store.discard(removed.before)
                self.store.discard(removed.after)
                if removed.after is not None:
                    self._status('actions_dropped', '操作缓存达到上限，保留较新操作', discontinuity=True)
        else:
            self.store.discard(pending['before'])
        setattr(self, name, None)

    def _event(self, event, now):
        """按事件坐标关联缓存首帧，合并连续键盘并对点击/滚动设置结束边界。"""
        display = display_at(self._displays, (event.x, event.y))
        if display is None or display.index not in self._frames:
            return
        if event.kind not in ('click', 'key', 'scroll'):
            return
        if event.kind == 'scroll' and self._last_scroll is not None:
            at, x, y = self._last_scroll
            if event.monotonic - self._scroll_started > self.settings.scrollResetSeconds:
                self._scroll_started = None
                self._scroll_count = 0
            else:
                if event.monotonic - at < self.settings.scrollDebounceSeconds:
                    return
                if math.hypot(event.x - x, event.y - y) < self.settings.scrollMinPointerDistance:
                    return
                if (self._scroll_count + 1) / (event.monotonic - self._scroll_started) > self.settings.scrollMaxEventsPerSecond:
                    return
        if event.kind != 'key':
            self._finish('_keyboard')
        self._last_monitor = display.index
        frame = self._frames[display.index]
        self._raw_events += 1
        if event.kind == 'key':
            if self._keyboard and self._keyboard['monitor'] != display.index:
                self._finish('_keyboard')
            if self._keyboard is None:
                self._keyboard = {'kind': 'key', 'monitor': display.index,
                                  'before': self.store.stage(frame)}
            self._keyboard['due'] = event.monotonic + self.settings.keyboardIdleSeconds
        else:
            name = '_click' if event.kind == 'click' else '_scroll'
            pending = getattr(self, name)
            if pending:
                self.store.discard(pending['before'])
            delay = (self.settings.clickDebounceSeconds if event.kind == 'click'
                     else self.settings.scrollAfterSeconds)
            setattr(self, name, {'kind': event.kind, 'monitor': display.index,
                                 'before': self.store.stage(frame),
                                 'due': event.monotonic + delay})
            if event.kind == 'scroll':
                if self._scroll_started is None:
                    self._scroll_started = event.monotonic
                self._scroll_count += 1
                self._last_scroll = (event.monotonic, event.x, event.y)

    def _publish(self, saved, reason):
        """检查内存JPEG后提交正式候选，依次保存采集元信息、刷新索引并通知消费者。

        saved为事件或定时内存快照，兼容已有文件调用。检查失败、停止或时序过旧
        时释放候选；JPEG提交失败上抛，metadata或index失败沿既有策略记录后继续通知。
        """
        # 本地OCR直接读取内存JPEG；通过后才开始正式图片文件提交。
        if self.guard is not None:
            source = saved.jpeg if isinstance(saved, BufferedFrame) else saved.path
            verdict = self.guard.evaluate(source, app=saved.app, bundle_id=saved.bundle_id)
            if verdict.blocked:
                self.store.discard(saved)
                self._status('privacy_blocked', '敏感内容已拦截：候选不发布、不落正式盘',
                             reason=verdict.reason, hits=list(verdict.hits),
                             app=saved.app, capturedAt=saved.at.isoformat())
                return
        if self._stop.is_set():
            self.store.discard(saved)
            return
        if self._last_emitted is not None and saved.at <= self._last_emitted:
            self.store.discard(saved)
            self._status('stale_candidate', '略过早于已发布图片的延迟候选')
            return
        if isinstance(saved, BufferedFrame) or self.store.event_home in saved.path.resolve().parents:
            saved = self.store.promote(saved, reason)
        self._sample_sequence += 1
        candidate = Candidate(saved, reason, self._generation, self._sample_sequence)
        try:
            save_capture(self.config, candidate, self.run_id)
        except (OSError, ValueError) as error:
            self._status('metadata_failed', '采集元信息保存失败：' + str(error))
        # 原图与采集事实先发布，再刷新派生清单并通知；队列溢出仍可从正式文件恢复。
        try:
            rebuild_day(self.config, saved.at.date().isoformat())
        except (OSError, ValueError) as error:
            self._status('index_failed', '截图索引刷新失败：' + str(error))
        try:
            self.candidates.put_nowait(candidate)
        except Full:
            try:
                dropped = self.candidates.get_nowait()
            except Empty:
                dropped = None
            if dropped is not None:
                self._status('queue_dropped', '候选消费较慢，保留较新图；已有正式图继续保留',
                             discontinuity=True, droppedAt=dropped.saved.at.isoformat(),
                             screenshot=str(dropped.saved.path))
                candidate = Candidate(saved, reason, self._generation, self._sample_sequence)
            self.candidates.put_nowait(candidate)
        self._last_emitted = saved.at
        self._status('candidate', '候选已选出', screenshot=str(saved.path),
                     display=saved.display.index, reason=reason, capturedAt=saved.at.isoformat())

    def _select_actions(self):
        """整理已完成操作，保留末段末条 after；选中图发布成功后清理事件图。"""
        if self._raw_events < self.settings.minRawEvents or not self._actions:
            return
        segments, scores, stable = segment_actions(
            self._actions, self.settings.segmentDifferenceThreshold,
            self.settings.stableComparisonCount, self.settings.missingImageDifference)
        latest = segments[-1][-1].after
        if latest is not None:
            self._publish(latest, 'action')
        self._status('segmented', '操作已分段并选择末段末条',
                     actions=len(self._actions), segments=len(segments), stableSegments=stable,
                     diffScores=scores[-self.settings.maxStoredActions:])
        for action in self._actions:
            self.store.discard(action.before)
            self.store.discard(action.after)
            action.before = action.after = None
        self._actions = self._actions[-self.settings.maxStoredActions:]
        self._raw_events = 0

    def _inspect(self):
        """选择最近交互屏，随后尝试指针所在屏与可用缓存。"""
        frame = self._frames.get(self._last_monitor)
        if frame is None:
            try:
                display = display_at(self._displays, self.backend.pointer())
                frame = self._frames.get(display.index) if display else None
            except Exception:
                frame = None
        return frame if frame is not None else next(iter(self._frames.values()), None)

    def tick(self, now=None):
        """执行一轮采集与选图；用于在线线程及按真实时间戳的确定性回放。

        参数 now 为单调秒，省略时读取时钟；后端、图片读写与选图都走同一实现。
        返回值为空；候选和状态分别通过公开队列接口取得。后端/保存异常上抛。
        """
        now = self.clock() if now is None else now
        self._refresh(now)
        idle = self.backend.idle_seconds()
        paused = self.backend.display_asleep() or idle >= self.settings.sensingIdleSeconds
        if paused:
            if not self._paused:
                self._clear_state()
                for frame in self._frames.values():
                    frame.image.close()
                self._frames.clear()
                self._status('paused', '系统空闲或显示器休眠，暂停采集', discontinuity=True)
            self._paused = True
            return
        if self._paused:
            self._clear_state()
            self._status('resumed', '输入恢复，重建新帧后继续观察', discontinuity=True)
            self._next_observation = None
        self._paused = False
        if self._dropped_events:
            self._status('input_dropped', '输入队列过载，重新建立操作首尾', discontinuity=True)
            self._clear_state()
            self._dropped_events = 0
        while True:
            try:
                event = self._events.get_nowait()
            except Empty:
                break
            self._event(event, now)
        self._capture()
        if self._stop.is_set():
            return
        for name in ('_click', '_keyboard', '_scroll'):
            pending = getattr(self, name)
            if pending and pending['due'] <= now:
                self._finish(name)
        if self._next_action is None or now >= self._next_action:
            self._select_actions()
            self._next_action = now + self.settings.actionIntervalSeconds
        if self._next_observation is None or now >= self._next_observation:
            window = max(self.settings.observationIntervalSeconds * self.settings.recentActivityMultiplier,
                         self.settings.observationIntervalSeconds + self.settings.recentActivityPaddingSeconds)
            if idle <= window:
                frame = self._inspect()
                if frame is not None:
                    saved = self.store.stage(frame)
                    try:
                        self._publish(saved, 'periodic')
                    finally:
                        self.store.discard(saved)
            if self._frames:
                self._next_observation = now + self.settings.observationIntervalSeconds

    def request_stop(self):
        """通知生产线程结束后续采集，返回后由close等待本轮资源回收。

        供活动入口的停止信号调用；只设置线程事件，当前截图保存沿原顺序收尾。
        当前模型调用与正式记录提交由主线程继续完成。
        """
        self._stop.set()

    def close(self):
        """停止生产并等待线程释放资源；超时明确报错，单轮回放也能清理资源。"""
        if self._closed:
            return
        self.request_stop()
        if self._thread is not None:
            self._thread.join(min(self.settings.shutdownTimeoutSeconds,self.config.control.timeoutSeconds))
            if self._thread.is_alive():
                raise RuntimeError('采集线程停止超时')
        else:
            self._release_resources()
        self._closed = True
        if self._fatal is not None:
            raise RuntimeError('采集退出异常：' + str(self._fatal)) from self._fatal

    def __enter__(self):
        return self.start()

    def __exit__(self, kind, error, traceback):
        self.close()
