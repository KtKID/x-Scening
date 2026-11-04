"""任务整理失败case固化：按 2026-10-30～11-01 真实KMH会话复现两类读取失败。

来源：home/kmh/logs 三天 91 次非零退出——模型并行读取不存在的 tasks.json（65次 ENOENT）、
输出截断后按结果标注的快照路径续读被范围校验拒绝（23次）。两类都以 dsh 退出码 1 到达 scening。
本文件用真实 KMHInterpreter.run 驱动退出码 1 的替身进程，核对诊断提取、稳定码映射、
正式文件保护，以及消除诱因的输入命名与提示词契约。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
import yaml
from scening import task_timeline as api
from scening.kmh_interpreter import KMHInterpreter
from scening.observer_config import load_config

DAY = '2026-11-01'
ENOENT_STDERR = ("scene-observer: Error: UNKNOWN: ENOENT: no such file or directory, "
                 "open '/observer-home/kmh/task-timeline-x/tasks.json'")
DENIED_STDERR = ("scene-observer: Error: UNKNOWN: 读取范围限于本轮 inputFile："
                 "/observer-home/kmh/task-timeline-x/organize-input.json")


def row(start='09:00', end='09:01', text='排查登录问题', app='Chrome'):
    return dict(start=f'{DAY}T{start}:00+08:00', end=f'{DAY}T{end}:00+08:00', app=app, analysis=text,
                screenshot='a.jpg', mini='a.jpg', source='screen')


class StubModel:
    """可控JSON替身，用于先生成一份正式任务日文件。"""
    def __init__(self, reply): self.reply = reply
    def run(self, *args, **kwargs): return json.dumps(self.reply, ensure_ascii=False)


class OrganizerFailureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='tmp'); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name); self.config = load_config().with_overrides(home=self.home)
        (self.home / 'records').mkdir()
        (self.home / 'records' / f'{DAY}.json').write_text(json.dumps([row()], ensure_ascii=False))

    def proposal(self):
        records, _ = api.read_activities(self.home, DAY)
        return dict(tasks=[dict(key='new', title='修复登录', object='登录', goal='修复异常')],
                    assignments=[dict(activityId=r['id'], taskKey='new') for r in records],
                    progress=[dict(taskKey='new', text='已定位异常', kind='observed', completionScope=None,
                                   evidence=[dict(activityId=records[0]['id'], sourceSignature=records[0]['signature'],
                                                  excerpt='排查登录问题')])])

    def failing_model(self, stderr_text, exit_code=1):
        """复现 dsh 失败形态：stdout 空、stderr 带 scene-observer 诊断、非零退出。"""
        worker = self.home / 'failing-kmh.py'
        worker.write_text('import sys\n'
                          f'sys.stderr.write({stderr_text!r} + "\\n")\n'
                          f'sys.exit({exit_code})\n', encoding='utf-8')
        return KMHInterpreter(self.home, command=[sys.executable, '-B', str(worker)], config=self.config)

    def test_prompt_declares_single_input_file_and_forbids_guessed_siblings(self):
        """输入为中性文件名且提示词声明单文件、无 tasks.json、截断续读沿用同一路径。"""
        outer = self; seen = {}
        class CheckingModel:
            def run(self, task, patch_path=None):
                patch = yaml.safe_load(patch_path.read_text())
                source = Path(patch[0]['config']['inputFile'])
                seen['name'] = source.name
                payload = json.loads(source.read_text(encoding='utf-8'))
                for key in ('day', 'tasks', 'activities', 'responseSchema', 'evidenceOptions'):
                    outer.assertIn(key, payload)
                outer.assertIn(f'都是{source}这一个文件的顶层字段', task)
                outer.assertIn('不存在tasks.json、responseSchema.json等任何其他文件', task)
                outer.assertIn(f'用同一路径{source}加offset和limit继续读取', task)
                outer.assertIn('不要改用返回内容中标注的其他路径', task)
                return json.dumps(outer.proposal(), ensure_ascii=False)
        api.organize_day(self.config, DAY, interpreter=CheckingModel())
        self.assertEqual(seen['name'], 'organize-input.json', '文件名不应诱导模型推断同级 tasks.json')

    def test_guessed_tasks_json_failure_surfaces_enoent_and_keeps_day_file(self):
        """模型读取不存在的 tasks.json：诊断携带 ENOENT，稳定码附真实原因，原任务日文件字节不变。"""
        api.organize_day(self.config, DAY, interpreter=StubModel(self.proposal()))
        target = self.home / 'task-timeline' / f'{DAY}.json'; before = target.read_bytes()
        (self.home / 'records' / f'{DAY}.json').write_text(
            json.dumps([row(), row('10:00', '10:01', '设计设置页')], ensure_ascii=False))
        with self.assertRaises(RuntimeError) as caught:
            api.organize_day(self.config, DAY, interpreter=self.failing_model(ENOENT_STDERR))
        self.assertEqual(str(caught.exception), 'KMH调用失败（ENOENT），退出码1')
        code, message = api.failure_diagnostic(caught.exception)
        self.assertEqual(code, 'TASK_ORGANIZER_RUNTIME_FAILURE')
        self.assertEqual(message, '任务整理调用失败：KMH调用失败（ENOENT），退出码1')
        self.assertEqual(target.read_bytes(), before)

    def test_snapshot_path_continuation_denied_surfaces_range_code(self):
        """截断后按快照路径续读被拒：诊断携带范围文案，不再只剩退出码。"""
        with self.assertRaises(RuntimeError) as caught:
            api.organize_day(self.config, DAY, interpreter=self.failing_model(DENIED_STDERR))
        self.assertEqual(str(caught.exception), 'KMH调用失败（读取范围限于本轮 inputFile），退出码1')
        code, message = api.failure_diagnostic(caught.exception)
        self.assertEqual(code, 'TASK_ORGANIZER_RUNTIME_FAILURE')
        self.assertIn('读取范围限于本轮 inputFile', message)
        self.assertFalse((self.home / 'task-timeline' / f'{DAY}.json').exists(), '失败不得生成任务日文件')

    def test_unknown_stderr_keeps_exit_code_without_fabricated_reason(self):
        """stderr 无已知标记时只报退出码，不编造原因；兜底码仍附完整异常文本。"""
        with self.assertRaises(RuntimeError) as caught:
            api.organize_day(self.config, DAY, interpreter=self.failing_model('node: segmentation fault', 139))
        self.assertEqual(str(caught.exception), 'KMH调用失败，退出码139')
        code, message = api.failure_diagnostic(caught.exception)
        self.assertEqual((code, message), ('TASK_ORGANIZER_RUNTIME_FAILURE', '任务整理调用失败：KMH调用失败，退出码139'))

    def test_expected_states_keep_plain_wording(self):
        """忙碌与取消属预期状态，不附异常文本；其余桶附首行原因。"""
        self.assertEqual(api.failure_diagnostic(BlockingIOError())[0], 'TASK_ORGANIZER_BUSY')
        self.assertNotIn('：', api.failure_diagnostic(BlockingIOError())[1])
        code, message = api.failure_diagnostic(ValueError('来源已变化，保留待重新整理\n第二行不应出现'))
        self.assertEqual(code, 'TASK_ORGANIZER_INVALID_RESULT')
        self.assertTrue(message.endswith('：来源已变化，保留待重新整理'))


if __name__ == '__main__':
    unittest.main()
