import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { publishLocalBuild } from '../src/version-check/build';
import { readLocalBuild } from '../src/version-check/check';
import {
  LOCAL_BUILD_MARKER,
  LocalBuildInfoSchema,
} from '../src/version-check/protocol';
import type { LocalBuildInfo } from '../src/version-check/protocol';

const project = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const previous = LocalBuildInfoSchema.parse({
  buildId: randomUUID(),
  version: '0.1.11',
  createdAt: '2026-11-03T00:00:00.000Z',
});
const next = {
  ...previous,
  buildId: randomUUID(),
  createdAt: '2026-11-03T01:00:00.000Z',
};
const relativeApp = 'mac-arm64/x-scening.app';
const resources = 'Contents/Resources';
async function outputs(root: string, buildId: string) {
  for (const [file, content] of [
    ['main/index.js', buildId],
    ['preload/index.cjs', 'preload'],
    ['renderer/index.html', '<html></html>'],
  ]) {
    const target = path.join(root, 'desktop/out', file ?? '');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content ?? '');
  }
}
async function packaged(output: string, build: LocalBuildInfo) {
  const app = path.join(output, relativeApp);
  await mkdir(path.join(app, resources), { recursive: true });
  await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(path.join(app, 'Contents/MacOS/x-scening'), 'executable');
  await writeFile(
    path.join(app, resources, 'app.asar'),
    [build.buildId, 'preload', '<html></html>'].join('\n'),
  );
  await writeFile(
    path.join(app, resources, 'local-client-build.json'),
    JSON.stringify(build),
  );
}
async function fixture(run: (root: string, marker: string) => Promise<void>) {
  const root = await mkdtemp(path.join(project, 'tmp/local-build-unit-'));
  const marker = path.join(root, LOCAL_BUILD_MARKER);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify(previous));
  await packaged(path.join(root, 'desktop/release'), previous);
  try {
    await run(root, marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
await test('U1 应用包完整发布到固定入口后才更新标记', async () => {
  await fixture(async (root, marker) => {
    let packagedCalled = false;
    await publishLocalBuild(
      root,
      next,
      async (build) => {
        await outputs(root, build.buildId);
        assert.equal((await readLocalBuild(root, previous)).status, 'current');
      },
      async (output) => {
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), previous);
        packagedCalled = true;
        await packaged(output, next);
      },
    );
    assert.equal(packagedCalled, true);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), next);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(
            root,
            'desktop/release',
            relativeApp,
            resources,
            'local-client-build.json',
          ),
          'utf8',
        ),
      ),
      next,
    );
    assert.equal((await readLocalBuild(root, previous)).status, 'available');
    assert.equal(
      (await readdir(path.dirname(marker))).some((name) =>
        name.endsWith('.tmp'),
      ),
      false,
    );
  });
});
await test('U2 编译失败、缺产物和打包失败均保持上次可用包与标记', async () => {
  await fixture(async (root, marker) => {
    const archive = path.join(
      root,
      'desktop/release',
      relativeApp,
      resources,
      'app.asar',
    );
    const original = await readFile(archive, 'utf8');
    for (const compile of [
      () => Promise.reject(new Error('编译失败')),
      () => Promise.resolve(),
      () => outputs(root, previous.buildId),
    ]) {
      await assert.rejects(
        publishLocalBuild(root, next, compile, (output) =>
          packaged(output, next),
        ),
      );
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), previous);
      assert.equal(await readFile(archive, 'utf8'), original);
    }
    for (const assemble of [
      () => Promise.reject(new Error('打包失败')),
      () => Promise.resolve(),
      (output: string) => packaged(output, previous),
    ]) {
      await assert.rejects(
        publishLocalBuild(
          root,
          next,
          () => outputs(root, next.buildId),
          assemble,
        ),
      );
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), previous);
      assert.equal(await readFile(archive, 'utf8'), original);
    }
  });
});
await test('U3 标记必须匹配固定应用包，缺失或损坏可恢复', async () => {
  await fixture(async (root, marker) => {
    assert.equal((await readLocalBuild(root, previous)).status, 'current');
    await writeFile(marker, JSON.stringify(next));
    assert.equal((await readLocalBuild(root, previous)).status, 'unavailable');
    await packaged(path.join(root, 'desktop/release'), next);
    assert.equal((await readLocalBuild(root, previous)).status, 'available');
    const archive = path.join(
      root,
      'desktop/release',
      relativeApp,
      resources,
      'app.asar',
    );
    await rm(archive);
    assert.equal((await readLocalBuild(root, previous)).status, 'unavailable');
    for (const content of [
      '{',
      JSON.stringify({ ...next, createdAt: 'bad-date' }),
    ]) {
      await writeFile(marker, content);
      assert.equal(
        (await readLocalBuild(root, previous)).status,
        'unavailable',
      );
    }
    await packaged(path.join(root, 'desktop/release'), next);
    await writeFile(marker, JSON.stringify(next));
    assert.equal((await readLocalBuild(root, next)).status, 'current');
  });
});

await test('发布签名失败时保留上一份应用和成功标记', async () => {
  await fixture(async (root, marker) => {
    await assert.rejects(
      publishLocalBuild(
        root,
        next,
        () => outputs(root, next.buildId),
        (output) => packaged(output, next),
        async (app) => {
          const staged = path.join(app, resources, 'local-client-build.json');
          assert.deepEqual(JSON.parse(await readFile(staged, 'utf8')), next);
          throw new Error('签名失败');
        },
      ),
      /签名失败/,
    );
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), previous);
    assert.equal((await readLocalBuild(root, previous)).status, 'current');
  });
});
await test('U4 连续构建复用唯一固定发布路径', async () => {
  await fixture(async (root) => {
    const entry = path.join(root, 'desktop/release', relativeApp);
    const inode = (await stat(entry)).ino;
    for (const info of [
      next,
      { ...next, buildId: randomUUID(), createdAt: '2026-11-03T02:00:00.000Z' },
    ]) {
      await publishLocalBuild(
        root,
        info,
        () => outputs(root, info.buildId),
        (output) => packaged(output, info),
      );
      assert.equal(
        (await stat(entry)).ino,
        inode,
        '固定入口目录保持原身份，Dock与别名继续指向新版',
      );
      assert.equal((await readLocalBuild(root, info)).status, 'current');
      assert.deepEqual(
        JSON.parse(
          await readFile(
            path.join(
              root,
              'desktop/release',
              relativeApp,
              resources,
              'local-client-build.json',
            ),
            'utf8',
          ),
        ),
        info,
      );
      assert.deepEqual(await readdir(path.join(root, 'desktop/release')), [
        'mac-arm64',
      ]);
      assert.deepEqual(
        await readdir(path.join(root, 'desktop/release/mac-arm64')),
        ['x-scening.app'],
      );
    }
  });
});

await test('U5 重复构建保持首个作业独占，完成后可继续发布', async () => {
  await fixture(async (root, marker) => {
    let unblock = () => {};
    let started = () => {};
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = publishLocalBuild(
      root,
      next,
      async () => {
        started();
        await gate;
        await outputs(root, next.buildId);
      },
      (output) => packaged(output, next),
    );
    try {
      await ready;
      await assert.rejects(
        publishLocalBuild(
          root,
          next,
          () => outputs(root, next.buildId),
          (output) => packaged(output, next),
        ),
        /已有客户端构建正在运行/,
      );
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), previous);
    } finally {
      unblock();
      await first;
    }
    assert.equal((await readLocalBuild(root, previous)).status, 'available');
  });
});

await test('U6 发布标记失败后恢复上一份完整应用', async () => {
  await fixture(async (root, marker) => {
    const archive = path.join(
      root,
      'desktop/release',
      relativeApp,
      resources,
      'app.asar',
    );
    const original = await readFile(archive, 'utf8');
    await rm(marker);
    await mkdir(marker);
    await assert.rejects(
      publishLocalBuild(
        root,
        next,
        () => outputs(root, next.buildId),
        (output) => packaged(output, next),
      ),
    );
    assert.equal(await readFile(archive, 'utf8'), original);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(
            root,
            'desktop/release',
            relativeApp,
            resources,
            'local-client-build.json',
          ),
          'utf8',
        ),
      ),
      previous,
    );
  });
});

await test('U8 首次改名保留原入口身份和旧版更新路径', async () => {
  await fixture(async (root, marker) => {
    const { rename } = await import('node:fs/promises');
    const current = path.join(root, 'desktop/release', relativeApp);
    const legacy = path.join(path.dirname(current), 'Observer.app');
    await rename(current, legacy);
    const inode = (await stat(legacy)).ino;
    await publishLocalBuild(
      root,
      next,
      () => outputs(root, next.buildId),
      (output) => packaged(output, next),
    );
    assert.equal((await stat(current)).ino, inode);
    assert.equal((await stat(legacy)).ino, inode);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(legacy, resources, 'local-client-build.json'),
          'utf8',
        ),
      ),
      next,
    );
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), next);
  });
});
