import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createRuntimeArchive,
  includeRuntimeSource,
  isPrivateRuntimePath,
  sanitizeRuntimeTree,
} from '../scripts/kmh-runtime-snapshot.mjs';

const project = path.resolve(import.meta.dirname, '../..');
const blocked = [
  '.env',
  '.env.production',
  'nested/.ENV.local',
  '.npmrc',
  '.netrc',
  '.aws/credentials',
  '.ssh/id_ed25519',
  'id_rsa',
  'private.pem',
  'private.key',
  'identity.p12',
  'identity.pfx',
  'credentials.json',
  'credentials.yaml',
  'credentials.production.toml',
  'auth.yml',
  'tokens.json',
  'secrets.ini',
  'client_secret_fixture.json',
  'id_ed25519.pub',
  'auth.json',
  'settings.local.json',
  'sessions-scening/run.jsonl',
  'history.sqlite',
  'history.sqlite3',
  'history.db',
  'history.sqlite-wal',
  'history.db-shm',
  'history.sqlite3-journal',
  'reports/fix/report.md',
  'logs/run.log',
  'test/input.json',
  'coverage/index.html',
  '.DS_Store',
  '._README.md',
  'lib/index.tsbuildinfo',
];
const allowed = [
  'package.json',
  'LICENSE',
  'README.md',
  'lib/index.js',
  'lib/index.js.map',
  'resources/beta/sessions/index.js',
  'core/credentials.js',
  'data/models.json',
  'lib/module.node',
];

await test('profile和依赖复制过滤敏感文件，保留SDK代码、原生资源和许可证', async () => {
  const directory = await mkdtemp(path.join(project, 'tmp/kmh-copy-filter-'));
  try {
    const source = path.join(directory, 'source');
    for (const relative of [...blocked, ...allowed]) {
      const file = path.join(source, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'synthetic-fixture-only');
    }
    for (const built of [false, true]) {
      const target = path.join(directory, String(built));
      await cp(source, target, {
        recursive: true,
        filter: (file) =>
          includeRuntimeSource(path.relative(source, file), built),
      });
      for (const relative of blocked) {
        assert.equal(isPrivateRuntimePath(relative), true, relative);
        await assert.rejects(lstat(path.join(target, relative)), {
          code: 'ENOENT',
        });
      }
      for (const relative of allowed) {
        assert.equal(
          await readFile(path.join(target, relative), 'utf8'),
          'synthetic-fixture-only',
        );
      }
    }
    assert.equal(includeRuntimeSource('node_modules/child/index.js'), false);
    assert.equal(includeRuntimeSource('src/index.ts', true), false);
    assert.equal(includeRuntimeSource('src/index.ts', false), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test('归档清理本机元数据并保留可执行文件、长路径与相对依赖链接', async () => {
  const directory = await mkdtemp(path.join(project, 'tmp/kmh-clean-archive-'));
  try {
    const runtime = path.join(directory, 'runtime');
    const archive = path.join(directory, 'runtime.tar.gz');
    const module = path.join(runtime, 'packages/fixture/index.js');
    await mkdir(path.dirname(module), { recursive: true });
    await mkdir(path.join(runtime, 'node_modules'), { recursive: true });
    await writeFile(module, 'export const fixture = true;');
    await writeFile(path.join(runtime, 'node'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    await writeFile(
      path.join(runtime, '.env'),
      'AUDIT_KEY=synthetic-fixture-only',
    );
    await writeFile(path.join(runtime, '._node'), 'synthetic-metadata');
    await mkdir(path.join(runtime, 'reports'), { recursive: true });
    await writeFile(path.join(runtime, 'reports/run.log'), 'synthetic-log');
    const longFile = `packages/fixture/${'long-directory-'.repeat(7)}/resource.txt`;
    await mkdir(path.dirname(path.join(runtime, longFile)), {
      recursive: true,
    });
    await writeFile(path.join(runtime, longFile), 'long-path-resource');
    await symlink(
      '../packages/fixture',
      path.join(runtime, 'node_modules/fixture'),
    );
    if (process.platform === 'darwin') {
      execFileSync('xattr', [
        '-w',
        'com.example.audit',
        'synthetic-metadata',
        module,
      ]);
    }
    const removed = await sanitizeRuntimeTree(runtime);
    assert.deepEqual(new Set(removed), new Set(['.env', '._node', 'reports']));
    await createRuntimeArchive(runtime, archive);
    // 用独立的stdlib解析器核验真实文件头，避免只验证归档参数。
    const verified = execFileSync(
      'python3',
      [
        '-c',
        `
import tarfile,sys,json
with tarfile.open(sys.argv[1]) as archive:
    members=archive.getmembers()
    assert members
    assert all(m.uid==0 and m.gid==0 and m.uname=='' and m.gname=='' for m in members)
    assert all(not m.pax_headers for m in members)
    assert all(not m.name.split('/')[-1].startswith('._') for m in members)
    by_name={m.name.removeprefix('./'):m for m in members}
    assert by_name['node'].mode & 0o111
    assert by_name['node_modules/fixture'].linkname=='../packages/fixture'
    assert archive.extractfile(by_name[sys.argv[2]]).read()==b'long-path-resource'
    assert '.env' not in by_name and 'reports/run.log' not in by_name
print('archive-headers-verified')
`,
        archive,
        longFile,
      ],
      { encoding: 'utf8' },
    );
    assert.match(verified, /archive-headers-verified/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test('归档失败时保留既有快照并清理临时文件', async () => {
  const directory = await mkdtemp(
    path.join(project, 'tmp/kmh-archive-failure-'),
  );
  try {
    const archive = path.join(directory, 'runtime.tar.gz');
    await writeFile(archive, 'previous-snapshot');
    await assert.rejects(
      createRuntimeArchive(path.join(directory, 'missing'), archive),
    );
    assert.equal(await readFile(archive, 'utf8'), 'previous-snapshot');
    assert.deepEqual(await readdir(directory), ['runtime.tar.gz']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
