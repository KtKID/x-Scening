import assert from 'node:assert/strict';
import { createPackage } from '@electron/asar';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';
import {
  checkPublishMode,
  checkReleaseTag,
  createReleaseArchive,
  ReleaseManifestSchema,
  verifyMacRelease,
} from '../src/release-artifacts';

const project = path.resolve(import.meta.dirname, '../..');
const mac = process.platform === 'darwin' && process.arch === 'arm64';

async function fixture(
  run: (
    root: string,
    app: string,
    rewrite: (mode: string) => Promise<void>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(project, 'tmp/release-artifacts-'));
  const app = path.join(root, 'x-scening.app');
  const resources = path.join(app, 'Contents/Resources');
  const input = path.join(root, 'asar-input');
  const build = {
    buildId: randomUUID(),
    version: '0.2.0',
    createdAt: '2026-11-05T00:00:00.000Z',
  };
  try {
    await mkdir(path.join(input, 'out/main'), { recursive: true });
    await mkdir(resources, { recursive: true });
    // 此夹具检查发布编排与失败传播；完整运行环境使用真实迁移包另行验收。
    const python = path.join(resources, 'python-runtime/.venv/bin');
    const scening = path.join(resources, 'python-runtime/src/scening');
    const dsh = path.join(
      resources,
      'kmh-runtime/node_modules/@deepseek-ai/dsh/lib',
    );
    await mkdir(python, { recursive: true });
    await mkdir(scening, { recursive: true });
    await mkdir(dsh, { recursive: true });
    await writeFile(path.join(scening, 'observer_config.py'), '# unit fixture');
    await writeFile(path.join(dsh, 'bin.js'), '// unit fixture');
    await writeFile(path.join(resources, 'kmh-runtime/catalog.json'), '{}');
    await writeFile(path.join(python, 'python'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    await writeFile(
      path.join(resources, 'kmh-runtime/node'),
      '#!/bin/sh\necho "@kmh/scene-observer"\n',
      { mode: 0o755 },
    );
    await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
    await writeFile(
      path.join(app, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.2.0</string><key>CFBundleIconFile</key><string>icon.icns</string></dict></plist>`,
    );
    await copyFile(
      path.join(project, 'desktop/resources/icons/app-icon.icns'),
      path.join(resources, 'icon.icns'),
    );
    await copyFile(
      path.join(
        project,
        'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      ),
      path.join(app, 'Contents/MacOS/Observer'),
    );
    await writeFile(
      path.join(resources, 'local-client-build.json'),
      JSON.stringify(build),
    );
    await writeFile(
      path.join(input, 'package.json'),
      JSON.stringify({ version: '0.2.0' }),
    );
    const rewrite = async (mode: string) => {
      await writeFile(
        path.join(input, 'out/main/index.js'),
        `const build = ${JSON.stringify(build)}; const mode = RuntimeModeSchema.parse("${mode}");`,
      );
      await createPackage(input, path.join(resources, 'app.asar'));
    };
    await rewrite('publish');
    await run(root, app, rewrite);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test('release: 标签格式和源码版本必须一致', () => {
  checkReleaseTag('v0.2.0', '0.2.0');
  assert.throws(() => checkReleaseTag('v0.2.1', '0.2.0'));
  assert.throws(() => checkReleaseTag('main', '0.2.0'));
  assert.throws(() => checkReleaseTag('v0.2.0;echo bad', '0.2.0'));
});

await test('release: 内置运行环境缺失时拒绝发布', { skip: !mac }, () =>
  fixture(async (_root, app) => {
    await rm(path.join(app, 'Contents/Resources/python-runtime'), {
      recursive: true,
      force: true,
    });
    await assert.rejects(verifyMacRelease(app, 'v0.2.0'), /内置/);
  }),
);

await test('release: 实际编译内容要求唯一publish注入点', () => {
  checkPublishMode('const mode = RuntimeModeSchema.parse("publish");');
  assert.throws(() => checkPublishMode('RuntimeModeSchema.parse("dev")'));
  assert.throws(() => checkPublishMode('const mode = "publish";'));
  assert.throws(() =>
    checkPublishMode(
      'RuntimeModeSchema.parse("publish");RuntimeModeSchema.parse("dev");',
    ),
  );
});

await test(
  'release: 真实ASAR、版本、构建标记、图标与arm64核对',
  { skip: !mac },
  () =>
    fixture(async (_root, app) => {
      const info = await verifyMacRelease(app, 'v0.2.0');
      assert.equal(info.mode, 'publish');
      assert.equal(info.version, '0.2.0');
      assert.equal(info.arch, 'arm64');
    }),
);

await test(
  'release: 重写同一路径后的dev包拒绝，输出目录保持零创建',
  { skip: !mac },
  () =>
    fixture(async (root, app, rewrite) => {
      await verifyMacRelease(app, 'v0.2.0');
      await rewrite('dev');
      const output = path.join(root, 'assets');
      await assert.rejects(
        createReleaseArchive(app, 'v0.2.0', output),
        /publish/,
      );
      await assert.rejects(stat(output));
    }),
);

await test('release: 包内版本及构建标记不一致时拒绝', { skip: !mac }, () =>
  fixture(async (_root, app) => {
    await assert.rejects(verifyMacRelease(app, 'v0.2.1'), /版本/);
    const marker = path.join(app, 'Contents/Resources/local-client-build.json');
    await writeFile(
      marker,
      JSON.stringify({
        buildId: randomUUID(),
        version: '0.2.0',
        createdAt: '2026-11-05T00:00:00.000Z',
      }),
    );
    await assert.rejects(verifyMacRelease(app, 'v0.2.0'), /构建标记/);
  }),
);

await test('release: 产品图标缺失或损坏时拒绝', { skip: !mac }, () =>
  fixture(async (_root, app) => {
    const icon = path.join(app, 'Contents/Resources/icon.icns');
    await rm(icon);
    await assert.rejects(verifyMacRelease(app, 'v0.2.0'));
    await writeFile(icon, 'broken icon');
    await assert.rejects(verifyMacRelease(app, 'v0.2.0'), /图标/);
  }),
);

await test(
  'release: ZIP解压回读同一构建并生成可复核SHA256',
  { skip: !mac },
  () =>
    fixture(async (root, app) => {
      const output = path.join(root, 'assets');
      const generated = await createReleaseArchive(app, 'v0.2.0', output);
      const raw: unknown = JSON.parse(
        await readFile(
          path.join(output, generated.archive.replace(/\.zip$/, '.json')),
          'utf8',
        ),
      );
      const manifest = ReleaseManifestSchema.parse(raw);
      const sha = createHash('sha256')
        .update(await readFile(path.join(output, manifest.archive)))
        .digest('hex');
      assert.equal(manifest.sha256, sha);
      assert.ok(
        (await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8')).includes(
          `${sha}  ${manifest.archive}`,
        ),
      );
    }),
);

await test('release: 工作流强制publish、先核验后上传，手动运行默认仅验证', async () => {
  const content = await readFile(
    path.join(project, '.github/workflows/release.yml'),
    'utf8',
  );
  const workflow = parseDocument(content, { uniqueKeys: true });
  assert.deepEqual(workflow.errors, []);
  assert.equal(
    workflow.getIn(['jobs', 'build', 'env', 'OBSERVER_BUILD_MODE']),
    'publish',
  );
  assert.equal(workflow.getIn(['permissions', 'contents']), 'read');
  assert.equal(workflow.getIn(['jobs', 'publish', 'needs']), 'build');
  assert.equal(
    workflow.getIn(['jobs', 'publish', 'permissions', 'contents']),
    'write',
  );
  assert.equal(
    workflow.getIn([
      'on',
      'workflow_dispatch',
      'inputs',
      'publish_release',
      'default',
    ]),
    false,
  );
  assert.ok(content.includes('npm run build:publish'));
  assert.ok(
    content.indexOf('npm run release:archive') <
      content.indexOf('actions/upload-artifact@'),
  );
  assert.ok(content.includes('sha256sum --check SHA256SUMS.txt'));
  assert.ok(content.includes('--verify-tag'));
});
