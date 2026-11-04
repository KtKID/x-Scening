import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { resolveBuildMode } from '../src/runtime-mode';
import { resolveConfiguredPath } from '../src/main/config-paths';
import { prepareRuntimePaths } from '../src/main/runtime-paths';
import { readLocalDay } from '../src/main/data';

const project = path.resolve(import.meta.dirname, '../..');

async function fixture(
  run: (root: string, user: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(project, 'tmp/publish-mode-'));
  const previousHome = process.env.HOME;
  const user = path.join(root, 'user');
  process.env.HOME = user;
  try {
    await writeFile(
      path.join(root, 'observer.yaml'),
      '# 发布配置注释保留\n' +
        (await readFile(path.join(project, 'observer.yaml'), 'utf8')),
    );
    await writeFile(
      path.join(root, 'observer.publish.yaml'),
      await readFile(path.join(project, 'observer.publish.yaml'), 'utf8'),
    );
    await run(root, user);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

await test('publish: 本地和普通CI默认dev，GitHub Release或tag构建自动publish', () => {
  assert.equal(resolveBuildMode({}), 'dev');
  assert.equal(resolveBuildMode({ GITHUB_ACTIONS: 'true' }), 'dev');
  assert.equal(
    resolveBuildMode({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'release' }),
    'publish',
  );
  assert.equal(
    resolveBuildMode({ GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'tag' }),
    'publish',
  );
  assert.equal(
    resolveBuildMode({
      OBSERVER_BUILD_MODE: 'dev',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_TYPE: 'tag',
    }),
    'dev',
  );
  assert.equal(resolveBuildMode({ OBSERVER_BUILD_MODE: 'publish' }), 'publish');
  assert.throws(() => resolveBuildMode({ OBSERVER_BUILD_MODE: 'invalid' }));
});

await test('publish: ~、相对和绝对路径按配置位置解析，空路径拒绝', () => {
  const config = '/project/observer.yaml';
  assert.equal(resolveConfiguredPath(config, '~', '/user'), '/user');
  assert.equal(
    resolveConfiguredPath(config, '~/.scening', '/user'),
    '/user/.scening',
  );
  assert.equal(
    resolveConfiguredPath(config, './home', '/user'),
    '/project/home',
  );
  assert.equal(
    resolveConfiguredPath(config, '/absolute/home', '/user'),
    '/absolute/home',
  );
  assert.throws(() => resolveConfiguredPath(config, '   ', '/user'));
});

await test('publish: dev沿用项目目录，读取期间保持用户目录零写入', () =>
  fixture(async (root, user) => {
    const layout = await prepareRuntimePaths(root, 'dev');
    assert.deepEqual(layout, {
      configPath: path.join(root, 'observer.yaml'),
      cacheRoot: path.join(root, 'desktop/.cache'),
      logRoot: path.join(root, 'logs'),
    });
    await assert.rejects(readFile(path.join(user, '.scening/observer.yaml')));
  }));

await test('publish: 首次创建用户配置，保留参数和注释，缓存及日志位于用户数据根', () =>
  fixture(async (root, user) => {
    const layout = await prepareRuntimePaths(
      root,
      'publish',
      undefined,
      undefined,
      user,
    );
    assert.equal(layout.configPath, path.join(user, '.scening/observer.yaml'));
    assert.equal(layout.cacheRoot, path.join(user, '.scening/desktop/.cache'));
    assert.equal(layout.logRoot, path.join(user, '.scening/logs'));
    const generated = await readFile(layout.configPath, 'utf8');
    const document = parseDocument(generated);
    assert.equal(document.get('home'), '~/.scening');
    assert.equal(document.get('screenshotDir'), '~/.scening/snapshots');
    assert.ok(generated.includes('# 发布配置注释保留'));
    const snapshot = await readLocalDay(root, '2026-11-04', layout.configPath);
    assert.deepEqual(snapshot.issues, []);
    assert.equal(snapshot.locations.home, path.join(user, '.scening'));
    assert.equal(
      snapshot.locations.screenshotDir,
      path.join(user, '.scening/snapshots'),
    );
  }));

await test('publish: 已有用户配置逐字保留，后续缓存跟随用户设置的home', () =>
  fixture(async (root, user) => {
    const first = await prepareRuntimePaths(
      root,
      'publish',
      undefined,
      undefined,
      user,
    );
    const content =
      '# 用户自定义\nhome: ~/custom-home\nscreenshotDir: ~/custom-shots\n';
    await writeFile(first.configPath, content);
    const second = await prepareRuntimePaths(
      root,
      'publish',
      undefined,
      undefined,
      user,
    );
    assert.equal(await readFile(second.configPath, 'utf8'), content);
    assert.equal(
      second.cacheRoot,
      path.join(user, 'custom-home/desktop/.cache'),
    );
  }));

await test('publish: 显式配置优先，默认用户配置保持零创建', () =>
  fixture(async (root, user) => {
    const explicit = path.join(root, 'custom.yaml');
    await writeFile(explicit, 'home: ./custom\nscreenshotDir: ./images\n');
    const layout = await prepareRuntimePaths(
      root,
      'publish',
      explicit,
      undefined,
      user,
    );
    assert.equal(layout.configPath, explicit);
    assert.equal(layout.logRoot, path.join(root, 'custom/logs'));
    await assert.rejects(readFile(path.join(user, '.scening/observer.yaml')));
  }));

await test('publish: 编入的模板可独立创建配置，目录阻塞和损坏配置保留原文件', () =>
  fixture(async (root, user) => {
    const templates = {
      base: await readFile(path.join(root, 'observer.yaml'), 'utf8'),
      publish: await readFile(path.join(root, 'observer.publish.yaml'), 'utf8'),
    };
    const layout = await prepareRuntimePaths(
      path.join(root, 'missing-source'),
      'publish',
      undefined,
      templates,
      user,
    );
    await writeFile(layout.configPath, 'home: [broken');
    await assert.rejects(
      prepareRuntimePaths(root, 'publish', undefined, templates, user),
    );
    assert.equal(await readFile(layout.configPath, 'utf8'), 'home: [broken');
    await rm(path.join(user, '.scening'), { recursive: true });
    await writeFile(path.join(user, '.scening'), 'blocked');
    await assert.rejects(
      prepareRuntimePaths(root, 'publish', undefined, templates, user),
    );
    assert.equal(
      await readFile(path.join(user, '.scening'), 'utf8'),
      'blocked',
    );
  }));

await test('publish: 非法发布路径在创建配置前拒绝', () =>
  fixture(async (root, user) => {
    const base = await readFile(path.join(root, 'observer.yaml'), 'utf8');
    await assert.rejects(
      prepareRuntimePaths(
        root,
        'publish',
        undefined,
        { base, publish: 'home: ""\nscreenshotDir: ~/images\n' },
        user,
      ),
    );
    await assert.rejects(readFile(path.join(user, '.scening/observer.yaml')));
    await mkdir(path.join(user, 'config'), { recursive: true });
    const explicit = path.join(user, 'config/observer.yaml');
    await writeFile(explicit, 'home: 123\nscreenshotDir: ~/images\n');
    await assert.rejects(
      prepareRuntimePaths(root, 'publish', explicit, undefined, user),
    );
  }));
