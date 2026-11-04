import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BackfillService } from '../src/main/backfill';
import { BackfillActionSchema, moveDay } from '../src/shared/protocol';
import { fixture, callCount, eventually, root } from './backfill-fixture';

await test('T1/T4 查询零调用；重复开始复用单作业；三加二尾批自动保存完成', async () => {
  const f = await fixture();
  const service = new BackfillService(root, f.configPath);
  try {
    const before = await service.read({ day: f.day });
    assert.equal(before.remaining, 5);
    assert.equal(await callCount(f.folder), 0);
    await Promise.all([
      service.control({ day: f.day, action: 'start' }),
      service.control({ day: f.day, action: 'start' }),
    ]);
    const other = await service.control({
      day: moveDay(f.day, -1),
      action: 'start',
    });
    assert.equal(other.activeDay, f.day);
    assert.equal(other.owned, false);
    await eventually(
      async () => (await service.read({ day: f.day })).state === 'completed',
    );
    assert.equal(await callCount(f.folder), 2);
    const rows: unknown = JSON.parse(
      await readFile(path.join(f.home, 'records', `${f.day}.json`), 'utf8'),
    );
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);
    await service.control({ day: f.day, action: 'start' });
    assert.equal(await callCount(f.folder), 2);
  } finally {
    await service.shutdown();
    await rm(f.folder, { recursive: true, force: true });
  }
});
await test('T5 停止在途模型保留原图；再次执行只处理剩余', async () => {
  const f = await fixture();
  const service = new BackfillService(root, f.configPath);
  try {
    await writeFile(path.join(f.folder, 'mode.txt'), 'slow');
    await service.control({ day: f.day, action: 'start' });
    await eventually(async () => (await callCount(f.folder)) === 1);
    const result = await service.control({ day: f.day, action: 'stop' });
    assert.equal(result.state, 'cancelled');
    assert.equal(result.remaining, 5);
    assert.equal(service.hasWork, false);
    await writeFile(path.join(f.folder, 'mode.txt'), 'success');
    await service.control({ day: f.day, action: 'start' });
    await eventually(
      async () => (await service.read({ day: f.day })).state === 'completed',
    );
    assert.equal(await callCount(f.folder), 3);
  } finally {
    await service.shutdown();
    await rm(f.folder, { recursive: true, force: true });
  }
});
await test('T5 模型失败后继续；退出取消自有工作并完成收尾', async () => {
  const f = await fixture();
  const service = new BackfillService(root, f.configPath);
  try {
    await writeFile(path.join(f.folder, 'mode.txt'), 'fail');
    await service.control({ day: f.day, action: 'start' });
    await eventually(
      async () => (await service.read({ day: f.day })).state === 'partial',
    );
    assert.equal((await service.read({ day: f.day })).remaining, 5);
    await writeFile(path.join(f.folder, 'mode.txt'), 'slow');
    await service.control({ day: f.day, action: 'start' });
    await eventually(async () => (await callCount(f.folder)) === 3);
    await service.shutdown();
    assert.equal(service.hasWork, false);
    assert.equal((await service.read({ day: f.day })).state, 'cancelled');
  } finally {
    await service.shutdown();
    await rm(f.folder, { recursive: true, force: true });
  }
});
await test('T2 IPC日期与动作严格校验', () => {
  for (const day of ['2026-02-30', '../2026-10-30', '2026-10-30\n'])
    assert.equal(
      BackfillActionSchema.safeParse({ day, action: 'start' }).success,
      false,
    );
  assert.equal(
    BackfillActionSchema.safeParse({ day: '2026-10-30', action: 'delete' })
      .success,
    false,
  );
});
await test('T3/T5 外部持有同日锁时复用状态，桌面停止只影响自有工作', async () => {
  const f = await fixture();
  const service = new BackfillService(root, f.configPath);
  const external = spawn(
    path.join(root, '.venv/bin/python'),
    [
      '-u',
      '-c',
      `import fcntl,sys
from pathlib import Path
folder=Path(sys.argv[1])/'backfill'/sys.argv[2]
folder.mkdir(parents=True)
with (folder/'.run.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    print('ready',flush=True)
    sys.stdin.read()`,
      f.home,
      f.day,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const done = new Promise<void>((resolve) =>
    external.on('close', () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      external.stdout.once('data', () => resolve());
      external.once('error', reject);
      external.once('exit', (code) => {
        if (code !== 0) reject(new Error('外部锁测试进程失败'));
      });
    });
    const started = await service.control({ day: f.day, action: 'start' });
    assert.equal(started.state, 'running');
    assert.equal(started.owned, false);
    assert.equal(
      (await service.control({ day: f.day, action: 'stop' })).state,
      'running',
    );
    assert.equal(await callCount(f.folder), 0);
    assert.equal(external.exitCode, null);
  } finally {
    external.stdin.end();
    await done;
    await service.shutdown();
    await rm(f.folder, { recursive: true, force: true });
  }
});
