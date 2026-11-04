import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { DailyReviewService } from '../src/main/daily-review';
import { TaskTimelineService } from '../src/main/task-timeline';
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
await test('每日阻塞时任务关联继续，退出回收真实模型进程，中断状态可重启读取', async () => {
  const parent = path.join(root, 'tmp/daily-review-automation');
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'shutdown-'));
  const home = path.join(folder, 'home');
  const day = '2026-11-01';
  const launcher = path.join(folder, 'model.mjs');
  const configPath = path.join(folder, 'observer.yaml');
  const service = new DailyReviewService(root, configPath);
  const tasks = new TaskTimelineService(root, configPath);
  try {
    await mkdir(path.join(home, 'summaries'), { recursive: true });
    await writeFile(
      path.join(home, 'summaries', `${day}.json`),
      JSON.stringify([
        {
          windowStart: `${day}T00:00:00+08:00`,
          windowEnd: `${day}T12:00:00+08:00`,
          generatedAt: `${day}T12:01:00+08:00`,
          summary: '合成的十二小时分析',
          timeline: [],
          gaps: [],
        },
      ]),
    );
    await writeFile(
      launcher,
      `import {writeFileSync,readFileSync} from 'node:fs';
const task=process.argv.at(-1);
if(task.includes('独立的每日温馨回顾')) {
  writeFileSync(${JSON.stringify(path.join(folder, 'pid.txt'))},String(process.pid));setInterval(()=>{},1000);
} else {
  const file=task.match(/读取(.+?)，/)[1];const input=JSON.parse(readFileSync(file,'utf8'));
  console.log(JSON.stringify({tasks:[{key:'new',title:'并行任务',object:'合成活动',goal:'验证独立调度'}],assignments:input.activities.map(row=>({activityId:row.id,taskKey:'new'})),progress:[]}));
}`,
    );
    const config = parseDocument(
      await readFile(path.join(root, 'observer.yaml'), 'utf8'),
    );
    config.set('home', home);
    config.set('screenshotDir', path.join(folder, 'screens'));
    config.set('kmhLauncher', launcher);
    await writeFile(configPath, config.toString());
    const pending = service.read({ day, source: 'local', refresh: true });
    let pid: number | undefined;
    for (let index = 0; index < 100; index++) {
      const value = await readFile(path.join(folder, 'pid.txt'), 'utf8').catch(
        () => '',
      );
      if (value) {
        pid = Number(value);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pid);
    assert.equal((await service.inspect(day)).phase, 'running');
    // 日报模型保持阻塞，同时通过原任务服务读取新增活动并完成真实Python提交。
    await mkdir(path.join(home, 'records'), { recursive: true });
    await writeFile(
      path.join(home, 'records', `${day}.json`),
      JSON.stringify([
        {
          start: `${day}T09:00:00+08:00`,
          end: `${day}T09:01:00+08:00`,
          app: 'Editor',
          analysis: '【测试数据】继续处理任务',
          screenshot: 'fixture.jpg',
          mini: 'fixture.jpg',
        },
      ]),
    );
    tasks.permit();
    const query = {
      day,
      source: 'local' as const,
      expectedSourceRevision: '',
      refreshReason: 'auto' as const,
    };
    let linked = await tasks.read(query);
    for (
      let index = 0;
      index < 60 && linked.view?.tasks.length !== 1;
      index++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      linked = await tasks.read(query);
    }
    assert.equal(linked.view?.tasks[0]?.title, '并行任务');
    assert.equal((await service.inspect(day)).phase, 'running');
    tasks.suspend();
    assert.equal((await service.inspect(day)).phase, 'running');
    await service.shutdown();
    assert.equal((await pending).status, 'error');
    assert.equal(service.hasWork, false);
    assert.throws(() => process.kill(pid, 0));
    const reopened = new DailyReviewService(root, configPath);
    const state = await reopened.inspect(day);
    assert.equal(state.phase, 'failed');
    assert.match(state.lastError?.message ?? '', /取消/);
    await reopened.shutdown();
  } finally {
    await tasks.shutdown();
    await service.shutdown();
    await rm(folder, { recursive: true, force: true });
  }
});
