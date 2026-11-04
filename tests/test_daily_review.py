"""每日回顾专项；隔离home与模型替身，合成文件在结束清理。"""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

from scening.daily_review import review_day
from scening.observer_config import load_config

ROOT = Path(__file__).resolve().parents[1]
DAY = '2026-10-28'


class Model:
    def __init__(self, response='今天你在推进 Observer，也整理了设计思路。调试确实需要耐心，每次定位都在帮你靠近答案。\n\n辛苦了，留一点时间休息吧。'):
        self.response = response
        self.calls = []

    def run(self, task, *, patch_path=None):
        settings = yaml.safe_load(Path(patch_path).read_text())[0]['config']
        self.calls.append((task, json.loads(Path(settings['inputFile']).read_text())))
        return self.response


class DailyReviewTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / 'tmp/daily-review'
        folder.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=folder)
        self.home = Path(self.temporary.name)
        self.config = load_config().with_overrides(home=self.home)
        self.model = Model()
        self.source = self.home / 'summaries' / f'{DAY}.json'
        self.target = self.home / 'daily-reviews' / f'{DAY}.json'
        self.rows = [self.row('10:00', '整理设计思路。'), self.row('09:00', '推进 Observer，调试遇到启动问题。')]
        self.source.parent.mkdir()
        self.source.write_text(json.dumps(self.rows, ensure_ascii=False))

    def tearDown(self):
        self.temporary.cleanup()

    def row(self, hour, text):
        return dict(windowStart=f'{DAY}T{hour}:00+08:00', windowEnd=f'{DAY}T{hour[:2]}:30:00+08:00', generatedAt=f'{DAY}T{hour[:2]}:31:00+08:00', timeline=[], gaps=[], summary=text, trigger='periodic')

    def test_t1_full_response_input_and_independent_file(self):
        original = self.source.read_bytes()
        result = review_day(self.config, DAY, interpreter=self.model)
        self.assertIsNotNone(result, '有周期总结时应生成每日回顾')
        self.assertEqual(result.status, 'ready')
        self.assertEqual(result.review.response, self.model.response)
        saved = json.loads(self.target.read_text())
        self.assertEqual(saved['sourceCount'], 2)
        self.assertEqual(saved['response'], self.model.response)
        task, snapshot = self.model.calls[0]
        self.assertIn('温馨', task)
        self.assertIn('困难', task)
        self.assertIn(str(self.config.dailyReview.maxChars), task)
        self.assertEqual(snapshot['day'], DAY)
        self.assertIn('09:00', snapshot['periods'][0]['windowStart'])
        self.assertEqual(original, self.source.read_bytes())
        self.assertEqual(list((self.home/'daily-reviews').glob('*.json')), [self.target])
        self.assertEqual(list((self.home/'kmh').glob('daily-review-*')), [])

    def test_t2_cache_refresh_and_model_failure_preserve_old(self):
        first = review_day(self.config, DAY, interpreter=self.model)
        self.assertIsNotNone(first, '首次生成应返回回顾')
        cached = review_day(self.config, DAY, interpreter=Model('cached should win'))
        self.assertEqual(first, cached)
        updated = review_day(self.config, DAY, refresh=True, interpreter=Model('更新后的完整正文。'))
        self.assertEqual(updated.review.response, '更新后的完整正文。')
        original = self.target.read_bytes()
        with patch.object(self.model, 'run', side_effect=RuntimeError('模型失败')):
            with self.assertRaisesRegex(RuntimeError, '模型失败'):
                review_day(self.config, DAY, refresh=True, interpreter=self.model)
        self.assertEqual(original, self.target.read_bytes())
        with patch('scening.daily_review_report.os.replace', side_effect=OSError('写入失败')):
            with self.assertRaisesRegex(OSError, '写入失败'):
                review_day(self.config, DAY, refresh=True, interpreter=self.model)
        self.assertEqual(original, self.target.read_bytes())
        self.assertEqual(list(self.target.parent.glob('*.tmp')), [])

    def test_t2b_cached_only_reads_file_without_model(self):
        """只读模式：缺日文件返回空态且零模型调用、不写文件；有日文件则原样返回。"""
        result = review_day(self.config, DAY, cached_only=True, interpreter=self.model)
        self.assertEqual(result.status, 'empty')
        self.assertIn('生成总结', result.message)
        self.assertEqual(self.model.calls, [], '只读模式不得调用模型')
        self.assertFalse(self.target.exists(), '只读模式不得生成日文件')
        generated = review_day(self.config, DAY, interpreter=self.model)
        self.assertEqual(generated.status, 'ready')
        cached = review_day(self.config, DAY, cached_only=True, interpreter=Model('不应调用'))
        self.assertEqual(cached.status, 'ready')
        self.assertEqual(cached.review.response, self.model.response)

    def test_t3_empty_invalid_inputs_and_blank_model(self):
        result = review_day(self.config, '2026-10-27', interpreter=self.model)
        self.assertIsNotNone(result, '空日期应返回明确空状态')
        self.assertEqual(result.status, 'empty')
        self.assertEqual(self.model.calls, [])
        for day in ('../2026-10-28', '2026-02-30', '20261028'):
            with self.assertRaises(ValueError):
                review_day(self.config, day, interpreter=self.model)
        self.source.write_text('{broken')
        with self.assertRaises(ValueError):
            review_day(self.config, DAY, interpreter=self.model)
        self.rows[0]['windowEnd'] = '2026-10-29T10:30:00+08:00'
        self.source.write_text(json.dumps(self.rows))
        with self.assertRaises(ValueError):
            review_day(self.config, DAY, interpreter=self.model)
        self.source.write_text(json.dumps([self.row('09:00', '真实摘要')]))
        with self.assertRaises(ValueError):
            review_day(self.config, DAY, interpreter=Model('  '))
        self.assertFalse(self.target.exists())

    def test_t3_existing_absolute_image_timeline_is_readable(self):
        self.rows[0]['timeline'] = [dict(start=f'{DAY}T10:00:00+08:00', end=f'{DAY}T10:20:00+08:00', app='Code', analysis='既有原分辨率截图记录', screenshot='/snapshots/frame.jpg', mini='/snapshots/frame.jpg')]
        self.source.write_text(json.dumps(self.rows))
        result = review_day(self.config, DAY, interpreter=self.model)
        self.assertEqual(result.status, 'ready')
        self.assertNotIn('timeline', self.model.calls[0][1]['periods'][0])

    def test_t5_multi_period_snapshot_survives_native_line_limit(self):
        """五段总结及大量缺口仍可被原生2000字符行上限完整读取。"""
        self.rows = []
        for index in range(5):
            row = self.row(f'{9+index:02d}:00', f'第{index+1}段总结：推进对应任务，当前阶段待确认。')
            row['gaps'] = [dict(start=row['windowStart'], end=row['windowEnd'], reason=f'合成缺口{gap}，保留实际覆盖范围。') for gap in range(11)]
            self.rows.append(row)
        self.source.write_text(json.dumps(self.rows, ensure_ascii=False))
        original = self.source.read_bytes()

        def read_limited(task, *, patch_path=None):
            settings = yaml.safe_load(Path(patch_path).read_text())[0]['config']
            text = Path(settings['inputFile']).read_text()
            limit = 2000  # 外部原生read的行截断边界，作为兼容性反例固定保留。
            self.assertLessEqual(max(map(len, text.splitlines())), limit, '每份周期总结与缺口应分行提供，原生read才能完整读取')
            visible = '\n'.join(line[:limit] for line in text.splitlines())
            decoded = json.loads(visible)
            self.assertEqual([row['summary'] for row in decoded['periods']], [row['summary'] for row in self.rows])
            self.assertEqual(sum(len(row['gaps']) for row in decoded['periods']), 55)
            self.assertIn('分页', task)
            self.assertIn(str(Path(settings['inputFile'])), task)
            return '五个时段已经完整读取，今天的推进都值得被看见。'

        with patch.object(self.model, 'run', side_effect=read_limited):
            result = review_day(self.config, DAY, interpreter=self.model)
        self.assertEqual(result.status, 'ready')
        self.assertEqual(result.review.sourceCount, 5)
        self.assertEqual(original, self.source.read_bytes())

    def test_t4_parallel_file_lock(self):
        import fcntl
        lock = self.home / 'daily-review-status' / f'.{DAY}.generate.lock'
        lock.parent.mkdir(parents=True, exist_ok=True)
        with lock.open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, '正在生成'):
                review_day(self.config, DAY, interpreter=self.model)
        self.assertEqual(self.model.calls, [])


if __name__ == '__main__':
    unittest.main()
