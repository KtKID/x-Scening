"""对外MCP查询服务：在stdio上提供总结、回顾与任务关联三个工具。

只读查询 home/summaries 与 home/task-timeline，生成回顾复用 daily_review
的缓存、锁与协议；stdout仅输出JSON-RPC响应，诊断沿异常与标准错误，
不引入额外依赖。
"""
from datetime import date, timedelta
import argparse
import json
import sys
from pathlib import Path

from scening.activity_memory import SUMMARY_LIST, captured_app_names
from scening.daily_review import DailyReviewError, DailyReviewReply, review_day
from scening.observer_config import load_config
from scening.task_store import read_activities, read_tasks

SERVER_NAME = 'x-scening'
SERVER_VERSION = '0.1.0'
PROTOCOL_VERSIONS = ('2024-11-05', '2025-03-26', '2025-06-18')

TOOLS = [
    {
        'name': 'list_period_summaries',
        'description': '获取指定日期范围内已保存的全部半小时周期总结（含窗口、正文、活动时间表与缺口），按窗口开始时间升序返回；范围内无总结文件的日期跳过，损坏日期单独报告。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'startDate': {'type': 'string', 'pattern': r'^\d{4}-\d{2}-\d{2}$', 'description': '起始日期，含当日，格式YYYY-MM-DD'},
                'endDate': {'type': 'string', 'pattern': r'^\d{4}-\d{2}-\d{2}$', 'description': '结束日期，含当日，格式YYYY-MM-DD'},
            },
            'required': ['startDate', 'endDate'],
        },
    },
    {
        'name': 'generate_daily_review',
        'description': '生成或读取指定日期的每日温馨回顾；已保存回顾默认直接返回，refresh为true时重新生成，回复为就绪/空/失败协议JSON。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'day': {'type': 'string', 'pattern': r'^\d{4}-\d{2}-\d{2}$', 'description': '回顾日期，格式YYYY-MM-DD'},
                'refresh': {'type': 'boolean', 'default': False, 'description': 'true时忽略缓存重新生成'},
            },
            'required': ['day'],
        },
    },
    {
        'name': 'list_task_associations',
        'description': '获取指定日期范围内每条活动的任务关联：status为linked（已关联，tasks列出taskId/title/action）、none（已整理且明确无关联，tasks为null）、unknown（尚未整理或来源已变化）；附任务目录与三态计数。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'startDate': {'type': 'string', 'pattern': r'^\d{4}-\d{2}-\d{2}$', 'description': '起始日期，含当日，格式YYYY-MM-DD'},
                'endDate': {'type': 'string', 'pattern': r'^\d{4}-\d{2}-\d{2}$', 'description': '结束日期，含当日，格式YYYY-MM-DD'},
            },
            'required': ['startDate', 'endDate'],
        },
    },
]


def _day(value, label):
    """校验工具日期边界；返回规范日期，非法输入抛带字段名的ValueError。"""
    try:
        parsed = date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError(f'{label}应为YYYY-MM-DD日期：{value}')
    if parsed.isoformat() != value:
        raise ValueError(f'{label}应为YYYY-MM-DD日期：{value}')
    return parsed


def list_period_summaries(config, start_value, end_value):
    """读取日期范围内全部半小时总结，返回合并查询结果。

    config为已校验快照；start_value/end_value为含首尾的YYYY-MM-DD。
    逐日读取home/summaries，缺失日跳过；单日读取或校验失败记入
    unreadableDays并继续，与活动窗口读取的容错口径一致。返回字典含
    days、summaryCount、按windowStart升序的summaries与unreadableDays；
    日期非法或start晚于end抛ValueError，总结文件保持只读。
    """
    start = _day(start_value, 'startDate')
    end = _day(end_value, 'endDate')
    if start > end:
        raise ValueError('startDate应早于或等于endDate')
    days = []
    summaries = []
    unreadable = []
    # 只生成范围内日期，最后一天为9999-12-31时同样保持有效。
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        path = config.home / 'summaries' / f'{day.isoformat()}.json'
        if path.exists():
            try:
                rows = SUMMARY_LIST.validate_json(path.read_text(encoding='utf-8'), context={'allow_absolute_images': True})
                if any(row.windowEnd.date() != day for row in rows):
                    raise ValueError('周期总结的结束日期与归档文件不符')
            except (OSError, ValueError):
                unreadable.append({'day': day.isoformat(), 'reason': '周期总结文件读取失败：' + path.name})
            else:
                days.append(day.isoformat())
                summaries.extend(rows)
    summaries.sort(key=lambda row: row.windowStart)
    return {'startDate': start_value, 'endDate': end_value, 'days': days,
            'summaryCount': len(summaries), 'summaries': [row.model_dump(mode='json') for row in summaries],
            'unreadableDays': unreadable}


def task_associations(config, start_value, end_value):
    """读取日期范围内每条活动的任务关联，返回逐日状态列表。

    config为已校验快照；start_value/end_value为含首尾的YYYY-MM-DD。
    逐日read_activities取得记录身份与签名，read_tasks取得已保存关联；
    记录未收录或来源签名变化视为unknown（与整理流程pending口径一致），
    已整理且taskLinks为空视为none（无关联），否则linked并列出目录中的
    任务标题。无records的日期跳过；任务文件损坏记issue且该日全unknown，
    坏活动行记issue不阻塞其他记录。返回字典列表，每项含organized、
    needsOrganization、tasks目录、activities三态明细、counts与issues；
    日期非法或start晚于end抛ValueError，正式记录与任务文件保持只读。
    """
    start = _day(start_value, 'startDate')
    end = _day(end_value, 'endDate')
    if start > end:
        raise ValueError('startDate应早于或等于endDate')
    days = []
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        records = config.home / 'records' / f'{day.isoformat()}.json'
        if not records.exists():
            continue
        issues = []
        try:
            rows, problems = read_activities(config.home, day.isoformat())
        except (OSError, ValueError):
            issues.append('活动文件读取失败：' + records.name)
            rows, problems = [], []
        issues.extend(problems)
        assignments = {}
        catalog = []
        organized = (config.home / 'task-timeline' / f'{day.isoformat()}.json').exists()
        if organized:
            try:
                document = read_tasks(config.home, day.isoformat())
            except (OSError, ValueError):
                organized = False
                issues.append('任务文件读取失败：' + f'{day.isoformat()}.json')
            else:
                catalog = [dict(taskId=task.taskId, title=task.title, object=task.object, goal=task.goal)
                           for task in document.tasks]
                assignments = {item.activityId: item for item in document.assignments}
        titles = {task['taskId']: task['title'] for task in catalog}
        counts = {'linked': 0, 'none': 0, 'unknown': 0}
        activities = []
        for row in rows:
            saved = assignments.get(row['id'])
            links = saved.taskLinks if saved is not None and saved.sourceSignature == row['signature'] else None
            if links is None:
                status, tasks = 'unknown', None
            elif links:
                status = 'linked'
                tasks = [dict(taskId=link.taskId, title=titles.get(link.taskId, link.taskId), action=link.action)
                         for link in links]
            else:
                status, tasks = 'none', None
            counts[status] += 1
            activities.append({'activityId': row['id'], 'start': row['start'], 'end': row['end'],
                               'app': '、'.join(captured_app_names(row)), 'analysis': row['analysis'],
                               'status': status, 'tasks': tasks})
        days.append({'day': day.isoformat(), 'organized': organized, 'needsOrganization': counts['unknown'] > 0,
                     'tasks': catalog, 'activityCount': len(activities), 'counts': counts,
                     'activities': activities, 'issues': issues})
    return days


def call_tool(config, name, arguments):
    """执行一个MCP工具，返回(文本结果, isError)。

    config为已校验快照；name为工具名，arguments为调用参数字典。
    列表工具的参数错误转为isError文本；回顾工具复用review_day的
    缓存与锁，异常包装为与CLI一致的失败协议并置isError。未知工具
    抛KeyError由协议层转为-32602。返回UTF-8 JSON文本，无文件副作用。
    """
    if name == 'list_period_summaries':
        try:
            result = list_period_summaries(config, arguments['startDate'], arguments['endDate'])
        except KeyError as missing:
            return json.dumps({'error': f'缺少必填参数：{missing.args[0]}'}, ensure_ascii=False), True
        except ValueError as error:
            return json.dumps({'error': str(error)}, ensure_ascii=False), True
        return json.dumps(result, ensure_ascii=False), False
    if name == 'generate_daily_review':
        try:
            reply = review_day(config, arguments['day'], refresh=bool(arguments.get('refresh', False)))
        except KeyError as missing:
            return json.dumps({'error': f'缺少必填参数：{missing.args[0]}'}, ensure_ascii=False), True
        except Exception as error:
            reply = DailyReviewError(message=f'每日总结生成失败：{error}')
        return DailyReviewReply(root=reply).model_dump_json(), isinstance(reply, DailyReviewError)
    if name == 'list_task_associations':
        try:
            entries = task_associations(config, arguments['startDate'], arguments['endDate'])
        except KeyError as missing:
            return json.dumps({'error': f'缺少必填参数：{missing.args[0]}'}, ensure_ascii=False), True
        except ValueError as error:
            return json.dumps({'error': str(error)}, ensure_ascii=False), True
        return json.dumps({'startDate': arguments['startDate'], 'endDate': arguments['endDate'],
                           'days': entries}, ensure_ascii=False), False
    raise KeyError(name)


def _error(identifier, code, message):
    """构造JSON-RPC错误响应；解析失败等无请求id的场景使用None。"""
    return {'jsonrpc': '2.0', 'id': identifier, 'error': {'code': code, 'message': message}}


def handle_message(config, message):
    """处理一条已解析的JSON-RPC消息，返回响应字典或None。

    请求必须携带id；无id的通知直接忽略。params与工具arguments在分发前
    校验为对象，省略或None沿用空对象。initialize按客户端请求回显
    受支持的协议版本，未知版本回退最早版本；ping、tools/list与
    tools/call构成查询子集。未知方法返回-32601，未知工具返回-32602；
    工具内部异常兜底为isError结果，保持服务循环不中断。返回的字典
    由serve写出，本函数无副作用。
    """
    identifier = message.get('id') if isinstance(message, dict) else None
    if not isinstance(message, dict) or message.get('jsonrpc') != '2.0' or not isinstance(message.get('method'), str):
        return _error(identifier, -32600, '无效请求')
    method = message['method']
    if identifier is None:
        return None
    params = message.get('params')
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return _error(identifier, -32602, 'params应为对象')
    def reply(result):
        return {'jsonrpc': '2.0', 'id': identifier, 'result': result}
    if method == 'initialize':
        requested = params.get('protocolVersion')
        version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return reply({'protocolVersion': version,
                      'capabilities': {'tools': {'listChanged': False}},
                      'serverInfo': {'name': SERVER_NAME, 'version': SERVER_VERSION}})
    if method == 'ping':
        return reply({})
    if method == 'tools/list':
        return reply({'tools': TOOLS})
    if method == 'tools/call':
        name = params.get('name')
        if not isinstance(name, str) or not name:
            return _error(identifier, -32602, '工具name应为非空字符串')
        arguments = params.get('arguments')
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            return _error(identifier, -32602, '工具arguments应为对象')
        try:
            text, is_error = call_tool(config, name, arguments)
        except KeyError:
            return _error(identifier, -32602, f'未知工具：{name}')
        except Exception as error:
            text, is_error = json.dumps({'error': f'工具执行失败：{error}'}, ensure_ascii=False), True
        return reply({'content': [{'type': 'text', 'text': text}], 'isError': is_error})
    return _error(identifier, -32601, f'未知方法：{method}')


def serve(config, source=None, target=None):
    """逐行读取JSON-RPC请求并写出响应，输入流结束后返回。

    source/target缺省使用标准输入输出；空行跳过，无法解析的行返回
    -32700。每条响应单独成行并立即刷新，通知不产生输出；读取或写
    入异常向调用方传播，由main统一退出。
    """
    source = sys.stdin if source is None else source
    target = sys.stdout if target is None else target
    for line in source:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            response = _error(None, -32700, 'JSON解析失败')
        else:
            response = handle_message(config, message)
        if response is not None:
            target.write(json.dumps(response, ensure_ascii=False) + '\n')
            target.flush()


def main():
    """独立CLI：按--config加载快照后在stdio上提供MCP工具。

    配置错误直接终止并向标准错误报告；正常期stdout只写JSON-RPC响应。
    """
    parser = argparse.ArgumentParser(description='对外MCP查询服务：半小时总结与每日回顾')
    parser.add_argument('--config', type=Path)
    args = parser.parse_args()
    serve(load_config(args.config))


if __name__ == '__main__':
    main()
