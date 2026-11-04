import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyReviewScheduler } from '../src/main/daily-review-scheduler';
import {
  DailyReviewCandidatesSchema,
  DailyReviewViewSchema,
} from '../src/shared/scening.generated';

await test('调度在独立任务执行，重复检查合并，后台完成后前台展示', async () => {
  const day = '2026-11-01';
  let calls = 0;
  let ready = false;
  const policy = {
    maxChars: 600,
    scheduledTime: '03:00',
    maxAutoAttempts: 3,
    retryIntervalSeconds: 60,
    checkIntervalSeconds: 30,
  };
  const view = () =>
    DailyReviewViewSchema.parse({
      day,
      homeId: 'h',
      revision: 'v',
      dueAt: '2026-11-02T03:00:00+08:00',
      maxAutoAttempts: 3,
      canSummarize: !ready,
      phase: ready ? 'succeeded' : 'scheduled',
      report: ready
        ? {
            day,
            generatedAt: '2026-11-02T08:00:00+08:00',
            sourceCount: 1,
            sourceHash: 'a'.repeat(64),
            response: '昨日完整报告',
          }
        : null,
    });
  const service = {
    candidates: () =>
      Promise.resolve(
        DailyReviewCandidatesSchema.parse({
          homeId: 'h',
          days: ready ? [] : [day],
          policy,
        }),
      ),
    inspect: () => Promise.resolve(view()),
    generate: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      ready = true;
      return view();
    },
  };
  let front = false;
  const opened: string[] = [];
  const scheduler = new DailyReviewScheduler(
    service,
    {
      changed: () => {},
      open: (value) => {
        opened.push(value.day);
      },
      problem: () => {},
    },
    () => front,
    () => new Date('2026-11-02T08:00:00+08:00'),
  );
  await Promise.all([scheduler.check(), scheduler.check()]);
  assert.equal(calls, 1);
  assert.deepEqual(opened, []);
  front = true;
  await scheduler.foreground();
  await scheduler.foreground();
  assert.deepEqual(opened, [day]);
  scheduler.stop();
});

await test('恢复时按剩余重试时间唤醒调度', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const base = new Date('2026-11-02T08:00:00+08:00');
  let elapsed = 0;
  let checks = 0;
  const service = {
    candidates: () => {
      checks++;
      return Promise.resolve(
        DailyReviewCandidatesSchema.parse({
          homeId: 'h',
          days: [],
          policy: {
            maxChars: 600,
            scheduledTime: '03:00',
            maxAutoAttempts: 3,
            retryIntervalSeconds: 60,
            checkIntervalSeconds: 30,
          },
          nextCheckAt: new Date(base.getTime() + 1000).toISOString(),
        }),
      );
    },
    inspect: () => Promise.reject(new Error('后台保持只读调度')),
    generate: () => Promise.reject(new Error('等待期间保持零调用')),
  };
  const scheduler = new DailyReviewScheduler(
    service,
    {
      changed: () => {},
      open: () => {},
      problem: (error) => {
        throw error;
      },
    },
    () => false,
    () => new Date(base.getTime() + elapsed),
  );
  try {
    scheduler.start();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(checks, 1);
    elapsed = 999;
    context.mock.timers.tick(999);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(checks, 1);
    elapsed = 1000;
    context.mock.timers.tick(1);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(checks, 2);
  } finally {
    scheduler.stop();
    context.mock.timers.reset();
  }
});

await test('读取期间失焦保留展示机会，回到前台后重新请求', async () => {
  let front = true;
  let release: ((value: unknown) => void) | undefined;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const value = DailyReviewViewSchema.parse({
    day: '2026-11-03',
    homeId: 'h',
    revision: 'v',
    dueAt: '2026-11-04T03:00:00+08:00',
    maxAutoAttempts: 3,
    canSummarize: false,
    phase: 'succeeded',
    report: {
      day: '2026-11-03',
      generatedAt: '2026-11-04T03:00:30+08:00',
      sourceCount: 1,
      sourceHash: 'a'.repeat(64),
      response: '已保存的昨日总结',
    },
  });
  const opened: string[] = [];
  const scheduler = new DailyReviewScheduler(
    {
      inspect: async () => DailyReviewViewSchema.parse(await pending),
      candidates: () => Promise.reject(new Error('本例只检查展示')),
      generate: () => Promise.reject(new Error('本例使用已保存报告')),
    },
    {
      changed: () => {},
      open: (view) => opened.push(view.day),
      problem: (error) => {
        throw error;
      },
    },
    () => front,
    () => new Date('2026-11-04T08:00:00+08:00'),
  );
  const checking = scheduler.foreground();
  front = false;
  release?.(value);
  await checking;
  assert.deepEqual(opened, []);
  front = true;
  await scheduler.foreground();
  assert.deepEqual(opened, ['2026-11-03']);
});
