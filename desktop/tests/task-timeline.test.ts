import test from 'node:test';
import assert from 'node:assert/strict';
import { taskAccent, investmentLabel } from '../src/shared/task-presentation';
import { TaskSelectionSchema } from '../src/shared/protocol';
import {
  ProposedTaskSchema,
  TaskSchema,
} from '../src/shared/scening.generated';

await test('新任务名至多10字符，历史长名称保持可读', () => {
  const proposal = {
    key: 'new',
    title: '一二三四五六七八九十',
    object: '登录接口',
    goal: '排查异常',
  };
  assert.equal(ProposedTaskSchema.safeParse(proposal).success, true);
  assert.equal(
    ProposedTaskSchema.safeParse({ ...proposal, title: `${proposal.title}一` })
      .success,
    false,
  );
  const title = '梳理Codex插件实现方案与ACP协议适配';
  assert.equal(
    TaskSchema.parse({
      taskId: 'existing',
      day: '2026-10-31',
      title,
      object: 'Codex插件',
      goal: '梳理方案',
    }).title,
    title,
  );
});

await test('T07/T21 同任务固定颜色，排序刷新不影响', () => {
  const original = taskAccent('login');
  for (const id of ['settings', 'draft', 'login']) taskAccent(id);
  assert.equal(taskAccent('login'), original);
  assert.equal(taskAccent(null), '#98988d');
});
await test('T22/T24 估算与时长待确认文案', () => {
  assert.equal(investmentLabel(4200, false), '约 70 分钟');
  assert.equal(investmentLabel(0, true), '时长待确认');
  assert.ok(investmentLabel(60, true).includes('部分时段待确认'));
});
await test('T18 空白范围选择可以没有目标片段', () => {
  const range = TaskSelectionSchema.parse({
    kind: 'range',
    day: '2026-10-30',
    source: 'local',
    sliceId: 'gap',
    start: '2026-10-30T09:00:00+08:00',
    end: '2026-10-30T09:30:00+08:00',
    segmentId: null,
  });
  assert.equal(range.kind, 'range');
});

await test('T27 真正Python桥接：只读开关、批次保存、end延长零额外模型调用', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } =
    await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { TaskTimelineService } = await import('../src/main/task-timeline');
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const temp = await mkdtemp(path.join(root, 'tmp/task-service-'));
  try {
    await mkdir(path.join(temp, 'home/records'), { recursive: true });
    const day = '2026-10-30';
    const records = [
      {
        start: `${day}T09:00:00+08:00`,
        end: `${day}T09:01:00+08:00`,
        app: 'Editor',
        analysis: '排查登录异常',
        screenshot: 'a.jpg',
        mini: 'a.jpg',
      },
    ];
    const target = path.join(temp, 'home/records', `${day}.json`);
    await writeFile(target, JSON.stringify(records));
    const launcher = path.join(temp, 'model.cjs');
    const calls = path.join(temp, 'calls.txt');
    await writeFile(
      launcher,
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(calls)},'call\\n');const task=process.argv.at(-1);const file=task.match(/读取(.+?)，/)[1];const input=JSON.parse(fs.readFileSync(file,'utf8'));console.log(JSON.stringify({tasks:[{key:'new',title:'修复登录',object:'登录',goal:'修复异常'}],assignments:input.activities.map(r=>({activityId:r.id,taskKey:'new'})),progress:[]}));`,
    );
    const config = (await readFile(path.join(root, 'observer.yaml'), 'utf8'))
      .replace(/^home:.*$/m, 'home: ./home')
      .replace(/^kmhLauncher:.*$/m, `kmhLauncher: ${launcher}`);
    const configPath = path.join(temp, 'observer.yaml');
    await writeFile(configPath, config);
    const service = new TaskTimelineService(root, configPath);
    service.runtime({
      capture: { state: 'stopped', message: '尚未启动' },
      analysisEnabled: false,
      refreshIntervalSeconds: 1,
      revision: 0,
    });
    const query = {
      day,
      source: 'local' as const,
      expectedSourceRevision: '',
      refreshReason: 'auto' as const,
    };
    assert.equal((await service.read(query)).organizing, 'disabled');
    service.permit();
    await service.read(query);
    let ready = await service.read(query);
    for (let i = 0; i < 40 && ready.view?.tasks.length !== 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ready = await service.read(query);
    }
    assert.equal(ready.view?.tasks[0]?.title, '修复登录');
    const firstCalls = await readFile(calls, 'utf8');
    assert.equal(firstCalls.trim(), 'call');
    const row = records[0];
    assert.ok(row);
    row.end = `${day}T09:03:00+08:00`;
    await writeFile(target, JSON.stringify(records));
    const extended = await service.read(query);
    assert.equal(extended.needsOrganization, false);
    assert.equal(await readFile(calls, 'utf8'), firstCalls);
    service.suspend();
    assert.equal((await service.read(query)).organizing, 'disabled');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

await test('T05/T27 失败批次达到上限后保持旧活动，停止回收整理进程', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, access } =
    await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { TaskTimelineService } = await import('../src/main/task-timeline');
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const temp = await mkdtemp(path.join(root, 'tmp/task-retry-'));
  let service: InstanceType<typeof TaskTimelineService> | null = null;
  try {
    await mkdir(path.join(temp, 'home/records'), { recursive: true });
    const day = '2026-10-30';
    const row = {
      start: `${day}T09:00:00+08:00`,
      end: `${day}T09:01:00+08:00`,
      analysis: '排查登录异常',
      screenshot: 'a.jpg',
      mini: 'a.jpg',
    };
    await writeFile(
      path.join(temp, 'home/records', `${day}.json`),
      JSON.stringify([row]),
    );
    const calls = path.join(temp, 'calls.txt');
    const launcher = path.join(temp, 'model.cjs');
    await writeFile(
      launcher,
      `require('fs').appendFileSync(${JSON.stringify(calls)},'call\\n');console.log('invalid proposal');`,
    );
    const { parseDocument } = await import('yaml');
    const document = parseDocument(
      await readFile(path.join(root, 'observer.yaml'), 'utf8'),
    );
    document.set('home', './home');
    document.set('kmhLauncher', launcher);
    document.setIn(['taskTimeline', 'minOrganizeIntervalSeconds'], 0.001);
    document.setIn(['taskTimeline', 'retryIntervalSeconds'], 0.001);
    const config = document.toString();
    const configPath = path.join(temp, 'observer.yaml');
    await writeFile(configPath, config);
    service = new TaskTimelineService(root, configPath);
    const query = {
      day,
      source: 'local' as const,
      expectedSourceRevision: '',
      refreshReason: 'auto' as const,
    };
    let count = 0;
    for (let i = 0; i < 20; i++) {
      await service.read(query);
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        count = (await readFile(calls, 'utf8')).trim().split('\n').length;
      } catch {
        /* 模型尚未启动时，调用记录暂未创建。 */
      }
      if (count >= 2 && !service.hasWork) break;
    }
    assert.equal(count, 2);
    for (let i = 0; i < 3; i++) await service.read(query);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
    assert.equal((await service.read(query)).view?.segments.length, 1);
    assert.ok(
      (await service.read(query)).issues.some((issue) =>
        issue.includes('TASK_ORGANIZER_INVALID_RESULT'),
      ),
    );
    assert.ok(
      !(await service.read({ ...query, day: '2026-10-29' })).issues.some(
        (issue) => issue.includes('TASK_ORGANIZER_INVALID_RESULT'),
      ),
    );
    await writeFile(
      launcher,
      `require('fs').appendFileSync(${JSON.stringify(calls)},'call\\n');setTimeout(()=>{},30000);`,
    );
    await service.read({ ...query, refreshReason: 'manual' });
    for (
      let i = 0;
      i < 20 && (await readFile(calls, 'utf8')).trim().split('\n').length < 3;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(service.hasWork, true);
    await service.shutdown();
    assert.equal(service.hasWork, false);
    assert.equal((await service.read(query)).organizing, 'disabled');
    await assert.rejects(
      access(path.join(temp, 'home/task-timeline', `${day}.json`)),
    );
  } finally {
    await service?.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});
