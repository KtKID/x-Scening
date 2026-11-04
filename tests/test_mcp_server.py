"""MCP查询服务专项；隔离home与模型替身，合成文件在结束清理。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scening.mcp_server import SERVER_NAME, call_tool, handle_message, list_period_summaries, serve, task_associations
from scening.observer_config import load_config
from scening.task_store import read_activities

ROOT = Path(__file__).resolve().parents[1]
DAY_FIRST = '2026-10-28'
DAY_MIDDLE = '2026-10-29'
DAY_LAST = '2026-10-30'


def summary(day, hour, text, **extra):
    """构造一份合法周期总结；extra用于核对扩展字段保留。"""
    row = dict(windowStart=f'{day}T{hour}:00:00+08:00', windowEnd=f'{day}T{hour}:30:00+08:00',
               generatedAt=f'{day}T{hour}:31:00+08:00',
               timeline=[dict(start=f'{day}T{hour}:00:00+08:00', end=f'{day}T{hour}:20:00+08:00', app='Code', analysis=text)],
               gaps=[], summary=text, trigger='periodic')
    row.update(extra)
    return row


class McpServerTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / 'tmp/mcp-server'
        folder.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=folder)
        self.home = Path(self.temporary.name)
        self.config = load_config().with_overrides(home=self.home)
        self.summaries = self.home / 'summaries'

    def tearDown(self):
        self.temporary.cleanup()

    def write_summary_file(self, day, rows):
        """写入指定日周期总结文件，返回路径。"""
        path = self.summaries / f'{day}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
        return path

    def call(self, name, arguments):
        """经handle_message发起tools/call，返回(result, isError)。"""
        message = {'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}}
        response = handle_message(self.config, message)
        self.assertIsNotNone(response)
        return response['result'], response['result'].get('isError', False)

    def test_t1_list_merges_range_sorted_and_skips_missing(self):
        self.write_summary_file(DAY_FIRST, [summary(DAY_FIRST, '10', '上午推进Observer。')])
        self.write_summary_file(DAY_LAST, [summary(DAY_LAST, '09', '第二天先整理文档。', mood='calm'),
                                           summary(DAY_LAST, '08', '更早时段。')])
        result = list_period_summaries(self.config, DAY_FIRST, DAY_LAST)
        self.assertEqual(result['days'], [DAY_FIRST, DAY_LAST])
        self.assertEqual(result['summaryCount'], 3)
        self.assertEqual([row['windowStart'] for row in result['summaries']],
                         sorted(row['windowStart'] for row in result['summaries']))
        self.assertEqual([row['summary'] for row in result['summaries']],
                         ['上午推进Observer。', '更早时段。', '第二天先整理文档。'])
        self.assertEqual(result['summaries'][2]['mood'], 'calm')
        self.assertEqual(result['summaries'][0]['timeline'][0]['app'], 'Code')
        self.assertEqual(result['unreadableDays'], [])
        single = list_period_summaries(self.config, DAY_MIDDLE, DAY_MIDDLE)
        self.assertEqual(single['summaries'], [])
        self.assertEqual(single['days'], [])
        self.assertEqual(single['summaryCount'], 0)

    def test_t2_list_invalid_dates(self):
        for start, end in (('20261028', DAY_LAST), ('2026-02-30', DAY_LAST), (DAY_LAST, DAY_FIRST), (DAY_FIRST, 'bad')):
            with self.assertRaises(ValueError):
                list_period_summaries(self.config, start, end)

    def test_t3_list_unreadable_day_does_not_block_others(self):
        self.write_summary_file(DAY_FIRST, [summary(DAY_FIRST, '10', '上午推进Observer。')])
        broken = self.write_summary_file(DAY_MIDDLE, [])
        broken.write_text('{broken', encoding='utf-8')
        self.write_summary_file(DAY_LAST, [summary(DAY_LAST, '09', '第二天先整理文档。')])
        result = list_period_summaries(self.config, DAY_FIRST, DAY_LAST)
        self.assertEqual(result['days'], [DAY_FIRST, DAY_LAST])
        self.assertEqual(result['summaryCount'], 2)
        self.assertEqual([row['day'] for row in result['unreadableDays']], [DAY_MIDDLE])
        self.assertIn(DAY_MIDDLE, result['unreadableDays'][0]['reason'])

    def test_t4_initialize_ping_tools_list_and_errors(self):
        init = handle_message(self.config, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                            'params': {'protocolVersion': '2025-03-26', 'capabilities': {}}})
        self.assertEqual(init['result']['protocolVersion'], '2025-03-26')
        self.assertEqual(init['result']['serverInfo']['name'], SERVER_NAME)
        self.assertIn('tools', init['result']['capabilities'])
        fallback = handle_message(self.config, {'jsonrpc': '2.0', 'id': 2, 'method': 'initialize',
                                                'params': {'protocolVersion': '9999-01-01'}})
        self.assertEqual(fallback['result']['protocolVersion'], '2024-11-05')
        self.assertEqual(handle_message(self.config, {'jsonrpc': '2.0', 'id': 3, 'method': 'ping'})['result'], {})
        listing = handle_message(self.config, {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/list'})
        tools = {tool['name']: tool for tool in listing['result']['tools']}
        self.assertEqual(set(tools), {'list_period_summaries', 'generate_daily_review', 'list_task_associations'})
        self.assertEqual(sorted(tools['list_period_summaries']['inputSchema']['required']), ['endDate', 'startDate'])
        self.assertEqual(tools['generate_daily_review']['inputSchema']['required'], ['day'])
        unknown = handle_message(self.config, {'jsonrpc': '2.0', 'id': 5, 'method': 'resources/list'})
        self.assertEqual(unknown['error']['code'], -32601)
        self.assertIsNone(handle_message(self.config, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}))

    def test_t5_generate_review_reply_and_is_error_mapping(self):
        from scening.daily_review import DailyReviewEmpty, DailyReviewReady
        ready = DailyReviewReady.model_validate({'review': {'day': DAY_FIRST, 'generatedAt': '2026-10-28T23:00:00+08:00',
                                                            'sourceCount': 1, 'sourceHash': 'a' * 64, 'response': '今天辛苦了。'}})
        with patch('scening.mcp_server.review_day', return_value=ready):
            text, is_error = call_tool(self.config, 'generate_daily_review', {'day': DAY_FIRST})
        payload = json.loads(text)
        self.assertEqual(payload['status'], 'ready')
        self.assertEqual(payload['review']['response'], '今天辛苦了。')
        self.assertFalse(is_error)
        with patch('scening.mcp_server.review_day', return_value=DailyReviewEmpty(message='这一天还没有半小时总结。')):
            text, is_error = call_tool(self.config, 'generate_daily_review', {'day': DAY_FIRST})
        self.assertEqual(json.loads(text)['status'], 'empty')
        self.assertFalse(is_error)
        with patch('scening.mcp_server.review_day', side_effect=RuntimeError('模型失败')):
            text, is_error = call_tool(self.config, 'generate_daily_review', {'day': DAY_FIRST})
        self.assertEqual(json.loads(text)['status'], 'error')
        self.assertTrue(is_error)
        with self.assertRaises(KeyError):
            call_tool(self.config, 'unknown_tool', {})
        response = handle_message(self.config, {'jsonrpc': '2.0', 'id': 8, 'method': 'tools/call',
                                                'params': {'name': 'unknown_tool', 'arguments': {}}})
        self.assertEqual(response['error']['code'], -32602)

    def test_t6_invalid_arguments_return_is_error_text(self):
        self.write_summary_file(DAY_FIRST, [summary(DAY_FIRST, '10', '上午推进Observer。')])
        _, is_error = self.call('list_period_summaries', {'startDate': '2026-02-30', 'endDate': DAY_LAST})
        self.assertTrue(is_error)
        result, is_error = self.call('list_period_summaries', {'startDate': DAY_FIRST, 'endDate': DAY_FIRST})
        self.assertFalse(is_error)
        self.assertEqual(json.loads(result['content'][0]['text'])['summaryCount'], 1)
        result, is_error = self.call('generate_daily_review', {})
        self.assertTrue(is_error)
        self.assertIn('day', result['content'][0]['text'])
        missing, is_error = self.call('list_period_summaries', {'startDate': DAY_FIRST})
        self.assertTrue(is_error)
        self.assertIn('endDate', missing['content'][0]['text'])

    def test_t7_serve_skips_blank_and_reports_parse_error(self):
        import io
        output = io.StringIO()
        serve(self.config, io.StringIO('\n{"jsonrpc": "2.0", "id": 1, "method": "ping"}\nnot-json\n'), output)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([row.get('id') for row in lines], [1, None])
        self.assertEqual(lines[0]['result'], {})
        self.assertEqual(lines[1]['error']['code'], -32700)

    def test_t8_smoke_subprocess_stdio_chain(self):
        """真实子进程链路：initialize→通知→tools/list→两个tools/call，空日期不触发模型。"""
        self.write_summary_file(DAY_FIRST, [summary(DAY_FIRST, '10', '上午推进Observer。')])
        config = ROOT / 'tmp/mcp-server/observer.yaml'
        text = (ROOT / 'observer.yaml').read_text(encoding='utf-8')
        config.write_text(text.replace('home: ./home', f'home: {self.home}'), encoding='utf-8')
        environment = dict(os.environ, PYTHONPATH=str(ROOT / 'src'))
        process = subprocess.Popen([sys.executable, '-B', '-m', 'scening.mcp_server', '--config', config],
                                   cwd=ROOT, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            requests = [
                {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}},
                {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                 'params': {'name': 'list_period_summaries', 'arguments': {'startDate': DAY_FIRST, 'endDate': DAY_LAST}}},
                {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call',
                 'params': {'name': 'generate_daily_review', 'arguments': {'day': DAY_MIDDLE}}},
            ]
            process.stdin.write(''.join(json.dumps(row) + '\n' for row in requests))
            process.stdin.close()
            replies = {}
            for _ in requests:
                if process.poll() is not None:
                    break
                line = process.stdout.readline()
                if not line:
                    break
                payload = json.loads(line)
                if payload.get('id') is not None:
                    replies[payload['id']] = payload
        finally:
            process.wait(timeout=10)
            diagnostics = process.stderr.read()
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(process.returncode, 0, diagnostics)
        self.assertEqual(replies[1]['result']['serverInfo']['name'], SERVER_NAME)
        self.assertEqual({tool['name'] for tool in replies[2]['result']['tools']},
                         {'list_period_summaries', 'generate_daily_review', 'list_task_associations'})
        listing = json.loads(replies[3]['result']['content'][0]['text'])
        self.assertEqual(listing['summaryCount'], 1)
        self.assertEqual(listing['days'], [DAY_FIRST])
        self.assertFalse(replies[3]['result']['isError'])
        review = json.loads(replies[4]['result']['content'][0]['text'])
        self.assertEqual(review['status'], 'empty')
        self.assertFalse(replies[4]['result']['isError'])
        self.assertFalse((self.home / 'daily-reviews').exists())


class TaskAssociationTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / 'tmp/mcp-server'
        folder.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=folder)
        self.home = Path(self.temporary.name)
        self.config = load_config().with_overrides(home=self.home)

    def tearDown(self):
        self.temporary.cleanup()

    def activity(self, day, clock, text, app='Code', frames=None):
        """构造一条合法活动记录；frames用于核对采集应用投影。"""
        from datetime import datetime, timedelta
        start = datetime.fromisoformat(f'{day}T{clock}:00+08:00')
        row = {'start': start.isoformat(), 'end': (start + timedelta(minutes=20)).isoformat(),
               'app': app, 'analysis': text, 'screenshot': 'records/a.jpg', 'mini': 'records/a.jpg'}
        if frames is not None:
            row['app'] = None
            row['frames'] = [dict(capturedAt=row['start'], screenshot='records/f.jpg', app=frames)]
        return row

    def fixture(self, day):
        """写入五条活动与任务文件：A/B关联、C无关联、D未整理、E来源已变化。"""
        rows = [self.activity(day, '09:00', '推进甲任务的记录A'),
                self.activity(day, '09:40', '同时推进甲乙的记录B', frames='Safari'),
                self.activity(day, '10:20', '目标不明的记录C'),
                self.activity(day, '11:00', '尚未整理的记录D'),
                self.activity(day, '11:40', '来源已变化的记录E')]
        records = self.home / 'records' / f'{day}.json'
        records.parent.mkdir(parents=True, exist_ok=True)
        records.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
        indexed = read_activities(self.home, day)[0]
        identity = {row['analysis']: (row['id'], row['signature']) for row in indexed}

        def evidence(text):
            identifier, signature = identity[text]
            return dict(activityId=identifier, sourceSignature=signature, excerpt=text)

        def link(task_id, text, action='推进'):
            return dict(taskId=task_id, action=action, evidence=[evidence(text)])

        def stale_link(task_id, text, action='推进'):
            """保存时的旧签名证据：记录随后被改写，来源签名不再一致。"""
            identifier, _ = identity[text]
            return dict(taskId=task_id, action=action,
                        evidence=[dict(activityId=identifier, sourceSignature='0' * 24, excerpt=text)])

        first, second = identity['推进甲任务的记录A'], identity['同时推进甲乙的记录B']
        third = identity['目标不明的记录C']
        fifth = identity['来源已变化的记录E']
        document = {'schemaVersion': 2, 'day': day, 'generatedAt': f'{day}T23:00:00+08:00', 'coveredUntil': None,
                    'semanticRevision': 'r1',
                    'tasks': [dict(taskId='T1', day=day, title='推进甲方案', object='甲方案', goal='完成甲'),
                              dict(taskId='T2', day=day, title='调研乙工具', object='乙工具', goal='输出结论')],
                    'assignments': [dict(activityId=first[0], sourceSignature=first[1],
                                         taskLinks=[link('T1', '推进甲任务的记录A')], relationVersion=2, unassignedEvidence=[]),
                                    dict(activityId=second[0], sourceSignature=second[1],
                                         taskLinks=[link('T1', '同时推进甲乙的记录B'), link('T2', '同时推进甲乙的记录B', action='调研')],
                                         relationVersion=2, unassignedEvidence=[]),
                                    dict(activityId=third[0], sourceSignature=third[1], taskLinks=[], relationVersion=2,
                                         unassignedEvidence=[dict(activityId=third[0], sourceSignature=third[1], excerpt='目标不明的记录C')]),
                                    dict(activityId=fifth[0], sourceSignature='0' * 24, taskLinks=[stale_link('T1', '来源已变化的记录E')],
                                         relationVersion=2, unassignedEvidence=[])],
                    'progress': []}
        target = self.home / 'task-timeline' / f'{day}.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')
        return day

    def test_t9_three_status_mapping(self):
        day = self.fixture(DAY_FIRST)
        result = task_associations(self.config, day, day)
        self.assertEqual(len(result), 1)
        entry = result[0]
        self.assertTrue(entry['organized'])
        self.assertTrue(entry['needsOrganization'])
        self.assertEqual(entry['counts'], {'linked': 2, 'none': 1, 'unknown': 2})
        self.assertEqual(entry['activityCount'], 5)
        self.assertEqual([task['title'] for task in entry['tasks']], ['推进甲方案', '调研乙工具'])
        statuses = {row['analysis']: row for row in entry['activities']}
        self.assertEqual(statuses['推进甲任务的记录A']['status'], 'linked')
        self.assertEqual(statuses['推进甲任务的记录A']['tasks'], [dict(taskId='T1', title='推进甲方案', action='推进')])
        self.assertEqual(statuses['同时推进甲乙的记录B']['status'], 'linked')
        self.assertEqual([item['title'] for item in statuses['同时推进甲乙的记录B']['tasks']], ['推进甲方案', '调研乙工具'])
        self.assertEqual(statuses['同时推进甲乙的记录B']['app'], 'Safari')
        self.assertEqual(statuses['目标不明的记录C']['status'], 'none')
        self.assertIsNone(statuses['目标不明的记录C']['tasks'])
        self.assertEqual(statuses['尚未整理的记录D']['status'], 'unknown')
        self.assertIsNone(statuses['尚未整理的记录D']['tasks'])
        self.assertEqual(statuses['来源已变化的记录E']['status'], 'unknown')
        self.assertEqual(entry['issues'], [])

    def test_t10_missing_and_corrupt_task_file(self):
        rows = [self.activity(DAY_FIRST, '09:00', '无任务文件的记录')]
        records = self.home / 'records' / f'{DAY_FIRST}.json'
        records.parent.mkdir(parents=True)
        records.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
        missing = task_associations(self.config, DAY_FIRST, DAY_FIRST)[0]
        self.assertFalse(missing['organized'])
        self.assertTrue(missing['needsOrganization'])
        self.assertEqual(missing['tasks'], [])
        self.assertEqual(missing['counts'], {'linked': 0, 'none': 0, 'unknown': 1})
        broken = self.home / 'task-timeline' / f'{DAY_FIRST}.json'
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text('{broken', encoding='utf-8')
        corrupt = task_associations(self.config, DAY_FIRST, DAY_FIRST)[0]
        self.assertFalse(corrupt['organized'])
        self.assertEqual(corrupt['counts']['unknown'], 1)
        self.assertTrue(any(DAY_FIRST in issue for issue in corrupt['issues']))

    def test_t11_range_and_bad_rows(self):
        self.fixture(DAY_FIRST)
        for start, end in ((DAY_LAST, DAY_FIRST), ('2026-02-30', DAY_LAST)):
            with self.assertRaises(ValueError):
                task_associations(self.config, start, end)
        result = task_associations(self.config, DAY_MIDDLE, DAY_MIDDLE)
        self.assertEqual(result, [])
        records = self.home / 'records' / f'{DAY_LAST}.json'
        records.parent.mkdir(parents=True, exist_ok=True)
        records.write_text(json.dumps([self.activity(DAY_LAST, '09:00', '完好记录'), {'broken': True}], ensure_ascii=False), encoding='utf-8')
        entry = task_associations(self.config, DAY_LAST, DAY_LAST)[0]
        self.assertEqual(entry['activityCount'], 1)
        self.assertEqual(len(entry['issues']), 1)
        self.assertEqual(entry['counts']['unknown'], 1)

    def test_t12_tools_list_grows(self):
        listing = handle_message(self.config, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
        tools = {tool['name']: tool for tool in listing['result']['tools']}
        self.assertEqual(set(tools), {'list_period_summaries', 'generate_daily_review', 'list_task_associations'})
        self.assertEqual(sorted(tools['list_task_associations']['inputSchema']['required']), ['endDate', 'startDate'])

    def test_t13_call_integration(self):
        day = self.fixture(DAY_FIRST)
        text, is_error = call_tool(self.config, 'list_task_associations', {'startDate': day, 'endDate': day})
        self.assertFalse(is_error)
        payload = json.loads(text)
        self.assertEqual(payload['days'][0]['counts'], {'linked': 2, 'none': 1, 'unknown': 2})
        bad = handle_message(self.config, {'jsonrpc': '2.0', 'id': 9, 'method': 'tools/call',
                                           'params': {'name': 'list_task_associations', 'arguments': {'startDate': 'bad', 'endDate': day}}})
        self.assertTrue(bad['result']['isError'])

    def test_t14_smoke_subprocess_three_statuses(self):
        day = self.fixture(DAY_FIRST)
        config = ROOT / 'tmp/mcp-server/observer-tasks.yaml'
        text = (ROOT / 'observer.yaml').read_text(encoding='utf-8')
        config.write_text(text.replace('home: ./home', f'home: {self.home}'), encoding='utf-8')
        environment = dict(os.environ, PYTHONPATH=str(ROOT / 'src'))
        process = subprocess.Popen([sys.executable, '-B', '-m', 'scening.mcp_server', '--config', config],
                                   cwd=ROOT, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            requests = [
                {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                 'params': {'name': 'list_task_associations', 'arguments': {'startDate': day, 'endDate': day}}},
            ]
            process.stdin.write(''.join(json.dumps(row) + '\n' for row in requests))
            process.stdin.close()
            replies = {}
            for _ in requests:
                line = process.stdout.readline()
                if not line:
                    break
                payload = json.loads(line)
                if payload.get('id') is not None:
                    replies[payload['id']] = payload
        finally:
            process.wait(timeout=10)
            diagnostics = process.stderr.read()
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(process.returncode, 0, diagnostics)
        self.assertEqual(replies[1]['result']['serverInfo']['name'], SERVER_NAME)
        payload = json.loads(replies[2]['result']['content'][0]['text'])
        self.assertFalse(replies[2]['result']['isError'])
        entry = payload['days'][0]
        self.assertEqual(entry['counts'], {'linked': 2, 'none': 1, 'unknown': 2})
        linked = next(row for row in entry['activities'] if row['status'] == 'linked')
        self.assertEqual(linked['tasks'][0]['taskId'], 'T1')


if __name__ == '__main__':
    unittest.main()
