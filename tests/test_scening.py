"""采集接入专项：后端替身隔离桌面与输入，图片、选图、线程和 JSON 保持真实。"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from queue import Empty
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scening import observe_activity as activity
from scening import runtime_logging as images
from scening.capture import Display, Frame, InputEvent, display_at
from scening.collector import SensingCollector
from scening.frame_store import Candidate, FrameStore
from scening.observer_config import load_config
from scening.selection import Action, image_difference, segment_actions


AT = datetime(2026, 10, 27, 10, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def wall(self):
        return AT + timedelta(seconds=self.value)


class Backend:
    def __init__(self):
        self.screens = [Display(1, 0, 0, 200, 100), Display(2, 200, 0, 200, 100)]
        self.point = (10, 10)
        self.idle = 0
        self.asleep = False
        self.colors = {1: 'red', 2: 'blue'}
        self.grabs = 0
        self.closed = False
        self.fail = False

    def displays(self):
        return self.screens

    def pointer(self):
        return self.point

    def idle_seconds(self):
        return self.idle

    def display_asleep(self):
        return self.asleep

    def grab(self, display):
        if self.fail:
            raise OSError('injected capture error')
        self.grabs += 1
        return Image.new('RGB', (display.width, display.height), self.colors[display.index])

    def start_inputs(self, submit, clock):
        return True

    def close(self):
        self.closed = True


class SceningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / "tmp")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'home'
        self.clock = Clock()
        self.backend = Backend()
        self.config = load_config().with_overrides(home=self.home, screenshotDir=self.home / 'pictures')
        self.log = Path(self.temp.name) / 'events.log'
        logger = patch.object(images, 'LOG_PATH', self.log)
        logger.start()
        self.addCleanup(logger.stop)
        images.initialize_logging()

    def collector(self, **changes):
        values = self.config.scening.model_dump()
        values.update(changes)
        config = self.config.with_overrides(scening=values)
        result = SensingCollector(config, backend=self.backend, clock=self.clock,
                                  wall_clock=self.clock.wall, app_provider=lambda display=None: ('Editor', 'test.editor'))
        self.addCleanup(result.close)
        return result

    def tick(self, collector, at):
        self.clock.value = at
        collector.tick(at)

    def event(self, collector, kind, at, point=(250, 10)):
        collector.submit_event(InputEvent(kind, point[0], point[1], at))
        self.tick(collector, at)

    def take(self, collector):
        return collector.next_candidate(timeout=0)

    def test_system_app_identity_is_selected_per_display_and_capture_race_is_unknown(self):
        collector = self.collector()
        calls = []
        def by_display(display):
            calls.append(display.index)
            return ('Editor', 'editor') if display.index == 1 else ('Browser', 'browser')
        collector.app_provider = by_display
        self.tick(collector, 0)
        first = self.take(collector)
        self.assertEqual((first.saved.display.index, first.saved.app, first.saved.bundle_id), (1, 'Editor', 'editor'))
        collector._last_monitor = 2
        self.tick(collector, self.config.scening.observationIntervalSeconds)
        second = self.take(collector)
        self.assertEqual((second.saved.display.index, second.saved.app, second.saved.bundle_id), (2, 'Browser', 'browser'))
        self.assertEqual(calls, [1, 1, 2, 2, 1, 1, 2, 2])
        with patch.object(collector, 'app_provider', side_effect=[('Editor', 'editor'), ('Browser', 'browser')] * 2):
            collector._capture()
        self.assertTrue(all(frame.app is None and frame.bundle_id is None for frame in collector._frames.values()))

    def test_t01_jpeg_native_pixels_alias_and_collision(self):
        store = FrameStore(self.config.screenshotDir, self.config.scening.jpegQuality)
        self.addCleanup(store.close)
        with Image.new('RGB', (1800, 900), 'green') as image:
            frame = Frame(image, AT, self.backend.screens[0], 'Editor', 'editor')
            first = store.save(frame, 'candidate', temporary=False)
            old = first.path.read_bytes()
            second = store.save(frame, 'candidate', temporary=False)
        self.assertNotEqual(first.path, second.path)
        self.assertEqual(first.path.read_bytes(), old)
        with Image.open(first.path) as image:
            self.assertEqual((image.format, image.size), ('JPEG', (1800, 900)))
        prepared = Candidate(first, 'test').prepared
        self.assertEqual(prepared.original, prepared.mini)
        self.assertEqual(prepared.mini_size, (1800, 900))

    def test_t02_monitor_boundaries_and_pointer_periodic(self):
        self.assertEqual(display_at(self.backend.screens, (200, 10)).index, 2)
        self.assertIsNone(display_at(self.backend.screens, (-1, 10)))
        self.backend.point = (250, 10)
        collector = self.collector()
        self.tick(collector, 0)
        candidate = self.take(collector)
        self.assertEqual(candidate.saved.display.index, 2)
        self.assertEqual(candidate.saved.app, 'Editor')
        self.assertEqual(candidate.saved.at, AT)

    def test_t03_high_resolution_branch_uses_strict_dimensions(self):
        collector = self.collector()
        self.backend.screens = [Display(1, 0, 0, 2560, 1600)]
        self.tick(collector, 0)
        self.assertEqual(collector.capture_fps, 5)
        self.backend.screens = [Display(1, 0, 0, 2561, 1600)]
        self.tick(collector, 2)
        self.assertEqual(collector.capture_fps, 3)

    def test_t04_click_debounce_selects_after_on_interaction_screen(self):
        collector = self.collector(minRawEvents=1)
        self.tick(collector, 0)
        self.take(collector)
        self.event(collector, 'click', .1)
        self.event(collector, 'click', .8)
        self.tick(collector, 2.7)
        self.assertIsNone(self.take(collector))
        self.backend.colors[2] = 'green'
        self.tick(collector, 2.9)
        self.tick(collector, 20)
        selected = self.take(collector)
        self.assertEqual(selected.reason, 'action')
        self.assertEqual(selected.saved.display.index, 2)
        self.assertEqual(selected.saved.at, AT + timedelta(seconds=2.9))
        self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])

    def test_t05_keyboard_retains_first_and_final_until_idle(self):
        """测试内容：回放连续键盘事件，等待输入空闲后检查首尾图缓存与选图结果。

        期望结果：首尾图保存在内存JPEG中，事件目录JPEG数量为零；最终选中图的采集时间
        为输入结束后的2.9秒，沿用原事件选图时间规则。
        """
        collector = self.collector()
        self.tick(collector, 0)
        self.take(collector)
        for at in (.1, .4, .8):
            self.event(collector, 'key', at)
        self.assertIsInstance(collector._keyboard['before'].jpeg, bytes)
        self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])
        self.tick(collector, 2.7)
        self.assertIsInstance(collector._keyboard['before'].jpeg, bytes)
        self.tick(collector, 2.9)
        self.assertIsInstance(collector._actions[-1].after.jpeg, bytes)
        self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])
        self.tick(collector, 20)
        self.assertEqual(self.take(collector).saved.at, AT + timedelta(seconds=2.9))

    def test_t06_scroll_filters_time_and_pointer_distance(self):
        collector = self.collector()
        self.tick(collector, 0)
        self.take(collector)
        self.event(collector, 'scroll', .1)
        self.event(collector, 'scroll', .2)
        self.tick(collector, 20)
        self.assertIsNone(self.take(collector))
        self.event(collector, 'scroll', 20.1, (270, 10))
        self.tick(collector, 40)
        self.assertEqual(self.take(collector).saved.display.index, 2)

    def test_t07_mse_units_missing_and_tail_coverage(self):
        store = FrameStore(self.config.screenshotDir, 70)
        self.addCleanup(store.close)
        saved = []
        for index, color in enumerate(('black', 'white')):
            with Image.new('RGB', (20, 10), color) as image:
                saved.append(store.save(Frame(image, AT, self.backend.screens[0]), str(index)))
        black, white = saved
        with Image.open(black.path) as a, Image.open(white.path) as b:
            # JPEG 编码会改变白色数值，按实际解码的纯色求解析期望。
            expected = 3 * (a.getpixel((0, 0))[0] - b.getpixel((0, 0))[0]) ** 2
        self.assertEqual(image_difference(black, white, self.config.scening.missingImageDifference), expected)
        self.assertEqual(image_difference(None, white, self.config.scening.missingImageDifference), self.config.scening.missingImageDifference)
        actions = [Action(black, white, 'test') for _ in range(4)]
        segments, scores, stable = segment_actions(actions, 8000, 2, self.config.scening.missingImageDifference)
        self.assertEqual([len(x) for x in segments], [1, 1, 1, 1])
        self.assertIs(segments[-1][-1], actions[-1])
        self.assertEqual(sum(map(len, segments)), 4)
        self.assertEqual(stable, 0)
        self.assertEqual(len(scores), 3)
        self.assertEqual(segment_actions(actions[:1], 8000, 2, self.config.scening.missingImageDifference)[0], [actions[:1]])

    def test_t08_stability_uses_comparisons_and_jpeg_modes(self):
        store = FrameStore(self.config.screenshotDir, 70)
        self.addCleanup(store.close)
        with Image.new('RGB', (20, 10), 'black') as image:
            saved = store.save(Frame(image, AT, self.backend.screens[0]), 'black')
        actions = [Action(saved, saved, 'test') for _ in range(3)]
        self.assertEqual(segment_actions(actions, 8000, 2, self.config.scening.missingImageDifference)[2], 1)
        self.assertEqual(segment_actions(actions[:2], 8000, 2, self.config.scening.missingImageDifference)[2], 0)

    def test_t09_periodic_is_independent_and_recent_activity_gated(self):
        collector = self.collector()
        self.tick(collector, 0)
        self.take(collector)
        self.tick(collector, 60)
        self.assertEqual(self.take(collector).reason, 'periodic')
        self.backend.idle = 121
        self.tick(collector, 120)
        self.assertIsNone(self.take(collector))

    def test_t10_idle_resume_clears_old_events(self):
        collector = self.collector(minRawEvents=1)
        self.tick(collector, 0)
        self.take(collector)
        self.event(collector, 'click', .1)
        self.backend.idle = 300
        before = self.backend.grabs
        self.tick(collector, 1)
        self.assertEqual(self.backend.grabs, before)
        self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])
        self.backend.idle = 0
        self.tick(collector, 2)
        self.assertEqual(self.take(collector).saved.at, AT + timedelta(seconds=2))
        self.assertTrue(any(event['result'] == 'paused' for event in collector.drain_status()))

    def test_t11_topology_change_resets_last_monitor(self):
        collector = self.collector(minRawEvents=1)
        self.tick(collector, 0)
        self.take(collector)
        self.event(collector, 'click', .1)
        self.backend.screens = self.backend.screens[:1]
        self.backend.point = (10, 10)
        self.tick(collector, 2)
        self.tick(collector, 60)
        self.assertEqual(self.take(collector).saved.display.index, 1)
        self.assertTrue(any(event['result'] == 'topology_changed' for event in collector.drain_status()))

    def test_t12_backlog_keeps_latest_and_preserves_all_formal_files(self):
        collector = self.collector(candidateQueueSize=1)
        self.tick(collector, 0)
        self.tick(collector, 60)
        candidate=self.take(collector)
        self.assertEqual(candidate.saved.at, AT + timedelta(seconds=60))
        self.assertEqual(candidate.sample_sequence,2)
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))), 2)
        self.assertTrue(any(event['result'] == 'queue_dropped' for event in collector.drain_status()))

    def test_t13_capture_failure_and_recovery(self):
        collector = self.collector()
        self.backend.fail = True
        self.tick(collector, 0)
        self.assertIsNone(self.take(collector))
        self.backend.fail = False
        self.tick(collector, 1)
        self.assertIsNotNone(self.take(collector))

    def test_t14_background_continues_during_slow_consumer(self):
        collector = SensingCollector(self.config, backend=self.backend)
        self.addCleanup(collector.close)
        collector.start()
        # 隐私闸门在发布前增加一次本地OCR（约10~50ms），超时放宽避免偶发超时
        candidate = collector.next_candidate(timeout=3)
        self.assertIsNotNone(candidate)
        before = self.backend.grabs
        time.sleep(.5)
        self.assertGreater(self.backend.grabs, before)
        collector.close()
        self.assertTrue(self.backend.closed)
        self.assertEqual(list((self.home / 'screenshot').glob('.events-*')), [])
        self.assertTrue(candidate.saved.path.exists())

    def test_t15_formal_write_failure_is_reported_without_deleting_history(self):
        collector = self.collector()
        self.tick(collector, 0)
        first = self.take(collector)
        old = first.saved.path.read_bytes()
        with patch.object(collector.store, 'promote', side_effect=OSError('injected save failure')):
            with self.assertRaisesRegex(OSError, 'injected save failure'):
                self.tick(collector, 60)
        self.assertEqual(first.saved.path.read_bytes(), old)

    def test_t16_activity_entry_consumes_candidates_without_legacy_capture(self):
        store = FrameStore(self.config.screenshotDir, 70)
        self.addCleanup(store.close)
        with Image.new('RGB', (100, 50), 'blue') as image:
            saved = store.save(Frame(image, AT, self.backend.screens[0], 'Editor', 'test.editor'), 'candidate', temporary=False)
        candidate = Candidate(saved, 'test')
        class Source:
            def __init__(self, *args, **kwargs):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def drain_status(self):
                return []
            def next_candidate(self, timeout=None):
                return candidate
        class Model:
            def analyze(self, path, frames=None):
                return '可见事实：编辑器画面。'
        with patch.object(activity, 'SensingCollector', Source, create=True), \
             patch.object(activity, 'KMHInterpreter', return_value=Model()), \
             patch.object(activity.permissions, 'screen_capture_allowed', return_value=True):
            self.assertEqual(activity.run_activity(self.home, interval=.001, count=3,config=self.config), 0)
        import json
        rows = json.loads((self.home / 'records/2026-10-27.json').read_text())
        self.assertEqual(rows[0]['screenshot'], rows[0]['mini'])
        self.assertEqual(rows[0]['app'], 'Editor')
        self.assertEqual(rows[0]['start'], AT.isoformat(timespec='seconds'))

    def test_t17_sleep_resume_generation_survives_candidate_backlog(self):
        collector = self.collector()
        self.tick(collector, 0)
        first = self.take(collector)
        self.tick(collector, 60)
        self.backend.asleep = True
        self.tick(collector, 61)
        self.backend.asleep = False
        self.tick(collector, 62)
        old = self.take(collector)
        fresh = self.take(collector)
        self.assertEqual(old.generation, first.generation)
        self.assertGreater(fresh.generation, old.generation)
        self.assertEqual(fresh.saved.at, AT + timedelta(seconds=62))

    def test_t18_application_change_during_capture_stays_unknown(self):
        calls = iter([('Before', 'before'), ('After', 'after')] * 2)
        collector = self.collector()
        collector.app_provider = lambda: next(calls)
        self.tick(collector, 0)
        saved = self.take(collector).saved
        self.assertIsNone(saved.app)
        self.assertIsNone(saved.bundle_id)

    def test_t19_input_backpressure_is_bounded_and_resets_linkage(self):
        collector = self.collector(maxStoredActions=2)
        self.tick(collector, 0)
        self.take(collector)
        for i in range(10):
            collector.submit_event(InputEvent('key', 250, 10, .1 + i / 100))
        self.tick(collector, 1)
        self.assertTrue(any(event['result'] == 'input_dropped' for event in collector.drain_status()))
        self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])

    def test_t20_configuration_checks_new_fields_and_legacy_fallback(self):
        import json
        from scening import observer_config
        values = self.config.model_dump(mode='json')
        del values['scening']
        path = Path(self.temp.name) / 'old-config.json'
        path.write_text(json.dumps(values))
        self.assertEqual(load_config(path).scening.jpegQuality, 70)
        for key, value in [('jpegQuality', 0), ('candidateQueueSize', 0), ('captureFps', float('inf')),
                           ('minRawEvents', True), ('newUnknown', 1)]:
            settings = self.config.scening.model_dump()
            settings[key] = value
            with self.assertRaises(ValueError):
                self.config.with_overrides(scening=settings)
        with patch.object(observer_config, 'DEFAULT_CONFIG_PATH', path):
            with self.assertRaisesRegex(ValueError, 'scening'):
                load_config(path)

    def test_t21_delayed_event_after_newer_periodic_does_not_reverse_time(self):
        collector = self.collector(minRawEvents=1, observationIntervalSeconds=5.0)
        self.tick(collector, 0)
        self.take(collector)
        self.event(collector, 'click', .1)
        self.tick(collector, 3)
        # 周期观察先于动作整理交付较新帧；迟到的旧 after 应被跳过。
        self.tick(collector, 5)
        newer = self.take(collector)
        self.tick(collector, 20)
        newest = self.take(collector)
        self.assertEqual(newest.reason, 'periodic')
        self.assertEqual(newest.saved.at, AT + timedelta(seconds=20))
        self.assertEqual(newer.saved.at, AT + timedelta(seconds=5))
        self.assertTrue(any(event['result'] == 'stale_candidate' for event in collector.drain_status()))

    def test_t22_generation_change_forces_existing_activity_to_reanalyze(self):
        from dataclasses import replace
        store = FrameStore(self.config.screenshotDir, 70)
        self.addCleanup(store.close)
        with Image.new('RGB', (100, 50), 'blue') as image:
            saved = store.save(Frame(image, AT, self.backend.screens[0], 'Editor', 'editor'), 'sample', temporary=False)
        queue = iter([Candidate(replace(saved, at=AT + timedelta(seconds=index)), 'test', 0 if index<3 else 1) for index in range(6)])
        class Source:
            def __init__(self, *args, **kwargs):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def drain_status(self):
                return []
            def next_candidate(self, timeout=None):
                return next(queue)
        class Model:
            calls = 0
            def analyze(self, path, frames=None):
                self.calls += 1
                return '可见事实：蓝色测试页面。'
        model = Model()
        with patch.object(activity, 'SensingCollector', Source), \
             patch.object(activity, 'KMHInterpreter', return_value=model), \
             patch.object(activity.permissions, 'screen_capture_allowed', return_value=True):
            self.assertEqual(activity.run_activity(self.home, interval=.001, count=6,config=self.config), 0)
        self.assertEqual(model.calls, 2)

    def test_t23_transient_save_failure_retries_in_background(self):
        collector = SensingCollector(self.config, backend=self.backend)
        self.addCleanup(collector.close)
        promote = collector.store.promote
        attempts = []
        def fail_once(*args):
            attempts.append(args)
            if len(attempts) == 1:
                raise OSError('injected temporary write failure')
            return promote(*args)
        with patch.object(collector.store, 'promote', side_effect=fail_once):
            collector.start()
            candidate = collector.next_candidate(timeout=3)
            self.assertIsNotNone(candidate)
        self.assertGreaterEqual(len(attempts), 2)
        self.assertTrue(any(event['result'] == 'round_failed' for event in collector.drain_status()))

    def test_t24_action_storage_limit_cleans_evicted_event_images(self):
        """测试内容：动作容量设为2，回放3次点击以触发旧动作淘汰，再执行选图。

        期望结果：动作数最多2个、首尾内存快照最多4张，事件目录JPEG数量为零；记录淘汰
        状态，后续选中最新动作2.2秒的画面，选图后事件目录JPEG数量仍为零。
        """
        collector = self.collector(maxStoredActions=2, minRawEvents=1, clickDebounceSeconds=.01)
        self.tick(collector, 0)
        self.take(collector)
        for index in range(3):
            self.event(collector, 'click', index + .1)
            self.tick(collector, index + .2)
            self.assertLessEqual(len(collector._actions), 2)
            buffered = [frame for action in collector._actions for frame in (action.before, action.after) if frame]
            self.assertLessEqual(len(buffered), 4)
            self.assertTrue(all(isinstance(frame.jpeg, bytes) for frame in buffered))
            self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])
        self.assertTrue(any(event['result'] == 'actions_dropped' for event in collector.drain_status()))
        self.tick(collector, 20)
        self.assertEqual(self.take(collector).saved.at, AT + timedelta(seconds=2.2))
        self.assertEqual(list(collector.store.event_home.rglob('*.jpg')), [])

    def test_t25_capture_only_runs_collector_without_model_or_records(self):
        def factory(config, **kwargs):
            return SensingCollector(config, backend=self.backend, app_provider=lambda display=None: ('Test', 'test'))
        with patch.object(activity, 'SensingCollector', factory), \
             patch.object(activity, 'KMHInterpreter', side_effect=AssertionError('仅采集模式调用了模型')), \
             patch.object(activity.permissions, 'screen_capture_allowed', return_value=True):
            self.assertEqual(activity.run_activity(self.home, count=1, capture_only=True, config=self.config), 0)
        self.assertEqual(len(list(self.config.screenshotDir.glob('????-??-??/*.jpg'))), 1)
        self.assertFalse((self.home / 'records').exists())
        self.assertFalse((self.home / 'summaries').exists())
        self.assertEqual(activity.main(['--capture-only', '--summary-on-exit']), 2)


if __name__ == '__main__':
    unittest.main()
