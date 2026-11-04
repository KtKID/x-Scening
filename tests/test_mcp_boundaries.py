"""MCP边界修复回归：固定输入、真实读取和协议循环，合成home结束即清理。"""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from scening.mcp_server import handle_message, list_period_summaries, serve, task_associations
from scening.observer_config import load_config


ROOT = Path(__file__).resolve().parents[1]
DAY = '2026-11-03'


def activity(start, text):
    """构造单时点活动，传入字符串同时作为原始时区保留的断言来源。"""
    return dict(start=start, end=start, app='Code', analysis=text,
                screenshot='evidence/test.jpg', mini='evidence/test.jpg')


def summary(start, end, text):
    """构造合法总结；generatedAt沿用结束时间，时间表和缺口可为空。"""
    return dict(windowStart=start, windowEnd=end, generatedAt=end,
                timeline=[], gaps=[], summary=text, trigger='periodic')


class McpBoundaryTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / 'tmp/mcp-boundaries-fix'
        folder.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=folder)
        self.home = Path(self.temporary.name)
        self.config = load_config().with_overrides(home=self.home)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, folder, day, rows):
        """仅写本用例的独占home；返回文件路径供原字节保持断言使用。"""
        path = self.home / folder / f'{day}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
        return path

    def assert_error_then_ping(self, method, params):
        """经真实serve循环验证错误响应及同一连接中后续ping的响应。"""
        messages = [dict(jsonrpc='2.0', id=1, method=method, params=params),
                    dict(jsonrpc='2.0', id=2, method='ping')]
        output = io.StringIO()
        serve(self.config, io.StringIO(''.join(json.dumps(r) + '\n' for r in messages)), output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(replies), 2)
        self.assertEqual(replies[0]['id'], 1)
        self.assertEqual(replies[0]['error']['code'], -32602)
        self.assertEqual(replies[1], dict(jsonrpc='2.0', id=2, result={}))

    def test_b1_params_shapes_return_error_and_continue(self):
        """B1：initialize/tools/call的5类非对象params均可恢复。"""
        for method in ('initialize', 'tools/call'):
            for params in ([], [1], 0, False, 'invalid'):
                with self.subTest(method=method, params=params):
                    self.assert_error_then_ping(method, params)

    def test_b1_tool_arguments_and_name_shapes(self):
        """B1邻接边界：错误arguments与name在分发前拒绝，后续ping继续。"""
        for arguments in ([], [1], 0, False, 'invalid'):
            with self.subTest(arguments=arguments):
                self.assert_error_then_ping('tools/call',
                    dict(name='list_task_associations', arguments=arguments))
        for name in (None, 0, ['list_task_associations']):
            with self.subTest(name=name):
                self.assert_error_then_ping('tools/call', dict(name=name, arguments={}))

    def test_b1_optional_params_and_arguments_preserve_compatibility(self):
        """修复前已接受的省略、null与空对象初始化及空工具参数继续可用。"""
        for extra in ({}, {'params': None}, {'params': {}}):
            with self.subTest(extra=extra):
                reply = handle_message(self.config, dict(jsonrpc='2.0', id=1, method='initialize', **extra))
                self.assertEqual(reply['result']['serverInfo']['name'], 'x-scening')
        for extra in ({}, {'arguments': None}, {'arguments': {}}):
            with self.subTest(extra=extra):
                reply = handle_message(self.config, dict(jsonrpc='2.0', id=2, method='tools/call',
                    params=dict(name='list_task_associations', **extra)))
                self.assertTrue(reply['result']['isError'])
                self.assertIn('startDate', reply['result']['content'][0]['text'])

    def test_b2_summaries_sort_by_instant_with_utc_z(self):
        """B2：01:00Z早于08:00Z，返回保留原时区和扩展字段。"""
        early = summary(DAY+'T09:00:00+08:00', DAY+'T09:30:00+08:00', 'early')
        late = summary(DAY+'T08:00:00Z', DAY+'T08:30:00Z', 'late')
        early['extension'] = 'preserved'
        self.write('summaries', DAY, [late, early])
        result = list_period_summaries(self.config, DAY, DAY)
        self.assertEqual([r['summary'] for r in result['summaries']], ['early', 'late'])
        self.assertEqual(result['summaries'][0]['windowStart'], early['windowStart'])
        self.assertEqual(result['summaries'][1]['windowStart'], late['windowStart'])
        self.assertEqual(result['summaries'][0]['extension'], 'preserved')

    def test_b2_activities_sort_by_instant_preserving_identity(self):
        """B2：用已校验的aware时间排序，原始时间与物理行身份保持。"""
        late = activity(DAY+'T08:00:00Z', 'late')
        early = activity(DAY+'T09:00:00+08:00', 'early')
        self.write('records', DAY, [late, early])
        rows = task_associations(self.config, DAY, DAY)[0]['activities']
        self.assertEqual([r['analysis'] for r in rows], ['early', 'late'])
        expected_id = hashlib.sha256(f'{DAY}:1:{early["start"]}'.encode()).hexdigest()[:24]
        self.assertEqual(rows[0]['activityId'], expected_id)
        self.assertEqual(rows[0]['start'], early['start'])
        self.assertEqual(rows[1]['start'], late['start'])

    def test_b3_maximum_date_missing_and_present_files(self):
        """B3：9999-12-31的缺失日和已存在空日文件均正常返回。"""
        day = '9999-12-31'
        self.assertEqual(task_associations(self.config, day, day), [])
        self.assertEqual(list_period_summaries(self.config, day, day)['summaryCount'], 0)
        self.write('records', day, [])
        self.write('summaries', day, [])
        self.assertEqual(task_associations(self.config, day, day)[0]['activityCount'], 0)
        result = list_period_summaries(self.config, day, day)
        self.assertEqual(result['days'], [day])
        self.assertEqual(result['summaryCount'], 0)

    def test_b3_maximum_date_nonempty_inclusive_range(self):
        """B3：9999-12-30至31包含末日有效活动和总结。"""
        for day in ('9999-12-30', '9999-12-31'):
            self.write('records', day, [activity(day+'T09:00:00+08:00', day)])
            self.write('summaries', day, [summary(day+'T09:00:00+08:00', day+'T09:30:00+08:00', day)])
        result = task_associations(self.config, '9999-12-30', '9999-12-31')
        self.assertEqual([d['day'] for d in result], ['9999-12-30', '9999-12-31'])
        self.assertEqual(list_period_summaries(self.config, '9999-12-30', '9999-12-31')['summaryCount'], 2)

    def test_b4_wrong_archive_day_is_reported_without_rewriting(self):
        """B4：错配文件整体记损坏，两侧有效日继续返回，文件原字节保留。"""
        for day in ('2026-11-02', '2026-11-04'):
            self.write('summaries', day, [summary(day+'T09:00:00+08:00', day+'T09:30:00+08:00', day)])
        wrong = summary('2026-11-04T10:00:00+08:00', '2026-11-04T10:30:00+08:00', 'wrong')
        path = self.write('summaries', DAY, [wrong])
        before = path.read_bytes()
        result = list_period_summaries(self.config, '2026-11-02', '2026-11-04')
        self.assertEqual(result['summaryCount'], 2)
        self.assertEqual(result['days'], ['2026-11-02', '2026-11-04'])
        self.assertEqual([d['day'] for d in result['unreadableDays']], [DAY])
        self.assertEqual(path.read_bytes(), before)

    def test_b4_midnight_window_belongs_to_end_day(self):
        """B4兼容：开始日前一日、结束日零点的合法总结保留。"""
        row = summary(DAY+'T23:30:00+08:00', '2026-11-04T00:00:00+08:00', 'midnight')
        self.write('summaries', '2026-11-04', [row])
        self.assertEqual(list_period_summaries(self.config, DAY, DAY)['summaryCount'], 0)
        result = list_period_summaries(self.config, '2026-11-04', '2026-11-04')
        self.assertEqual(result['summaryCount'], 1)
        self.assertEqual(result['unreadableDays'], [])

    def test_same_day_returns_every_record_including_midday(self):
        """全天范围返回已保存的全部3条，前后日记录各自保留。"""
        clocks = ('00:00:00', '12:00:00', '23:59:59')
        self.write('records', DAY, [activity(f'{DAY}T{clock}+08:00', clock) for clock in clocks])
        for day in ('2026-11-02', '2026-11-04'):
            self.write('records', day, [activity(day+'T12:00:00+08:00', 'outside')])
        result = task_associations(self.config, DAY, DAY)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['activityCount'], 3)
        self.assertEqual([r['analysis'] for r in result[0]['activities']], list(clocks))


if __name__ == '__main__':
    unittest.main()
