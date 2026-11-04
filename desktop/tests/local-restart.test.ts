import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalClientRestart } from '../src/version-check/restart';
import { localClientPaths } from '../src/version-check/paths';
import {
  LOCAL_BUILD_MARKER,
  LocalBuildInfoSchema,
} from '../src/version-check/protocol';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const running = LocalBuildInfoSchema.parse({
  buildId: randomUUID(),
  version: '0.1.12',
  createdAt: '2026-11-03T00:00:00.000Z',
});
const next = {
  ...running,
  buildId: randomUUID(),
  createdAt: '2026-11-03T01:00:00.000Z',
};

async function fixture(run: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(path.join(root, 'tmp/local-restart-'));
  const client = localClientPaths(folder);
  await mkdir(path.dirname(client.executable), { recursive: true });
  await mkdir(path.dirname(client.info), { recursive: true });
  await mkdir(path.dirname(path.join(folder, LOCAL_BUILD_MARKER)), {
    recursive: true,
  });
  await writeFile(client.executable, 'executable');
  await writeFile(client.archive, 'archive');
  await writeFile(client.info, JSON.stringify(next));
  await writeFile(path.join(folder, LOCAL_BUILD_MARKER), JSON.stringify(next));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

await test('J1 完成收尾后才安排固定入口重启并退出', async () =>
  fixture(async (folder) => {
    const entered = deferred();
    const gate = deferred();
    const events: string[] = [];
    const restart = createLocalClientRestart(folder, running, {
      shutdown: async () => {
        events.push('shutdown');
        entered.release();
        await gate.promise;
        events.push('ready');
      },
      relaunch: (options) => {
        assert.deepEqual(options, {
          execPath: localClientPaths(folder).executable,
          args: [],
        });
        events.push('relaunch');
      },
      quit: () => {
        events.push('quit');
      },
    });
    const pending = restart();
    await entered.promise;
    assert.deepEqual(events, ['shutdown']);
    gate.release();
    await pending;
    assert.deepEqual(events, ['shutdown', 'ready', 'relaunch', 'quit']);
  }));

await test('J2 连续请求共用一次收尾及重启', async () =>
  fixture(async (folder) => {
    const entered = deferred();
    const gate = deferred();
    const events: string[] = [];
    const restart = createLocalClientRestart(folder, running, {
      shutdown: async () => {
        events.push('shutdown');
        entered.release();
        await gate.promise;
      },
      relaunch: () => {
        events.push('relaunch');
      },
      quit: () => {
        events.push('quit');
      },
    });
    const first = restart();
    const second = restart();
    await entered.promise;
    gate.release();
    await Promise.all([first, second]);
    await restart();
    assert.deepEqual(events, ['shutdown', 'relaunch', 'quit']);
  }));

await test('J3 缺失损坏当前或不匹配包均保留原窗口', async () => {
  for (const kind of ['missing', 'broken', 'current', 'mismatch'])
    await fixture(async (folder) => {
      const marker = path.join(folder, LOCAL_BUILD_MARKER);
      const events: string[] = [];
      if (kind === 'missing') await rm(marker);
      if (kind === 'broken') await writeFile(marker, '{');
      if (kind === 'current') {
        await writeFile(marker, JSON.stringify(running));
        await writeFile(localClientPaths(folder).info, JSON.stringify(running));
      }
      if (kind === 'mismatch')
        await writeFile(localClientPaths(folder).info, JSON.stringify(running));
      const restart = createLocalClientRestart(folder, running, {
        shutdown: () => {
          events.push('shutdown');
          return Promise.resolve();
        },
        relaunch: () => {
          events.push('relaunch');
        },
        quit: () => {
          events.push('quit');
        },
      });
      await assert.rejects(
        restart(),
        kind === 'current' ? /当前已是最新构建/ : /应用包尚未完整就绪/,
      );
      assert.deepEqual(events, []);
    });
});

await test('J4 收尾失败保留完整原因并允许重试', async () =>
  fixture(async (folder) => {
    const events: string[] = [];
    let attempts = 0;
    const restart = createLocalClientRestart(folder, running, {
      shutdown: () => {
        attempts++;
        if (attempts === 1)
          return Promise.reject(
            new Error('采集退出等待超时：原始原因 E_STOP_42'),
          );
        events.push('shutdown');
        return Promise.resolve();
      },
      relaunch: () => {
        events.push('relaunch');
      },
      quit: () => {
        events.push('quit');
      },
    });
    await assert.rejects(restart(), /采集退出等待超时：原始原因 E_STOP_42/);
    assert.deepEqual(events, []);
    await restart();
    assert.deepEqual(events, ['shutdown', 'relaunch', 'quit']);
    assert.equal(attempts, 2);
  }));

await test('J5 收尾期间新包失去一致性则保留原窗口', async () =>
  fixture(async (folder) => {
    const events: string[] = [];
    const restart = createLocalClientRestart(folder, running, {
      shutdown: async () => {
        events.push('shutdown');
        await writeFile(localClientPaths(folder).info, JSON.stringify(running));
      },
      relaunch: () => {
        events.push('relaunch');
      },
      quit: () => {
        events.push('quit');
      },
    });
    await assert.rejects(restart(), /应用包尚未完整就绪/);
    assert.deepEqual(events, ['shutdown']);
  }));

await test('J6 原生重启安排失败时保留原窗口且可重试', async () =>
  fixture(async (folder) => {
    const events: string[] = [];
    let attempts = 0;
    const restart = createLocalClientRestart(folder, running, {
      shutdown: async () => {},
      relaunch: () => {
        if (++attempts === 1) throw new Error('relaunch failed: E_LAUNCH_7');
        events.push('relaunch');
      },
      quit: () => {
        events.push('quit');
      },
    });
    await assert.rejects(restart(), /relaunch failed: E_LAUNCH_7/);
    assert.deepEqual(events, []);
    await restart();
    assert.deepEqual(events, ['relaunch', 'quit']);
  }));

await test('J7 重启辅助进程安排完成后才退出当前窗口', async () =>
  fixture(async (folder) => {
    const entered = deferred();
    const ready = deferred();
    const events: string[] = [];
    const restart = createLocalClientRestart(folder, running, {
      shutdown: () => Promise.resolve(),
      relaunch: async () => {
        events.push('scheduling');
        entered.release();
        await ready.promise;
        events.push('scheduled');
      },
      quit: () => {
        events.push('quit');
      },
    });
    const pending = restart();
    await entered.promise;
    assert.deepEqual(events, ['scheduling']);
    ready.release();
    await pending;
    assert.deepEqual(events, ['scheduling', 'scheduled', 'quit']);
  }));
