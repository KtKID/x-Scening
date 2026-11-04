import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BackgroundsReplySchema } from '../src/shared/protocol';
import { TaskTimelineService } from '../src/main/task-timeline';
import { BackfillService } from '../src/main/backfill';
import { fixture, callCount, eventually, root } from './backfill-fixture';

await test('T1 后台作业协议解析合法负载并拒绝多余字段', () => {
  const payload = {
    organizing: { running: true, day: '2026-10-30' },
    backfill: { running: false, activeDay: null },
  };
  assert.deepEqual(BackgroundsReplySchema.parse(payload), payload);
  // 与其余协议一致采用 strict 策略：多余字段与非法日期不进入渲染层。
  assert.equal(
    BackgroundsReplySchema.safeParse({ ...payload, extra: 1 }).success,
    false,
  );
  assert.equal(
    BackgroundsReplySchema.safeParse({
      ...payload,
      organizing: { running: true, day: '2026-13-01' },
    }).success,
    false,
  );
});

await test('T2 任务整理服务默认无后台作业', () => {
  const service = new TaskTimelineService(
    root,
    path.join(root, 'observer.yaml'),
  );
  assert.deepEqual(service.background(), { running: false, day: null });
});

await test('T3 补分析服务空闲与运行中的后台快照', async () => {
  const f = await fixture();
  const service = new BackfillService(root, f.configPath);
  try {
    assert.deepEqual(service.background(), {
      running: false,
      activeDay: null,
    });
    await writeFile(path.join(f.folder, 'mode.txt'), 'slow');
    await service.control({ day: f.day, action: 'start' });
    assert.deepEqual(service.background(), {
      running: true,
      activeDay: f.day,
    });
    await eventually(async () => (await callCount(f.folder)) === 1);
    await service.control({ day: f.day, action: 'stop' });
    assert.deepEqual(service.background(), {
      running: false,
      activeDay: null,
    });
  } finally {
    await service.shutdown();
    await rm(f.folder, { recursive: true, force: true });
  }
});
