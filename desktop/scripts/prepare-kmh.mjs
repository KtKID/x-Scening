// 将scening及生产依赖闭包物化到应用资源；所有链接均指向资源内部。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  createRuntimeArchive,
  includeRuntimeSource,
  sanitizeRuntimeTree,
} from './kmh-runtime-snapshot.mjs';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const output = path.join(desktop, '.cache/kmh-runtime');
const snapshotDirectory = path.join(root, 'vendor/kmh-scening');
const snapshotArchive = path.join(snapshotDirectory, 'runtime.tar.gz');
const snapshotInfo = path.join(snapshotDirectory, 'snapshot.json');
const repack = process.argv.includes('--repack');
if (!process.argv.includes('--sync')) {
  const info = JSON.parse(await readFile(snapshotInfo, 'utf8'));
  const archive = await readFile(snapshotArchive);
  if (createHash('sha256').update(archive).digest('hex') !== info.sha256)
    throw new Error('KMH运行快照校验失败，请重新同步。');
  if (info.platform !== process.platform || info.arch !== process.arch)
    throw new Error(
      `KMH运行快照适用于${info.platform}/${info.arch}，请在目标平台重新同步。`,
    );
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  execFileSync(
    'tar',
    [
      '--no-xattrs',
      '--no-acls',
      '--no-fflags',
      '-xzf',
      snapshotArchive,
      '-C',
      output,
    ],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
  await sanitizeRuntimeTree(output);
  await cp(
    path.join(desktop, 'scripts/kmh-launcher.mjs'),
    path.join(output, 'kmh.mjs'),
  );
  if (repack) {
    await createRuntimeArchive(output, snapshotArchive);
    const cleaned = await readFile(snapshotArchive);
    await writeFile(
      snapshotInfo,
      JSON.stringify(
        {
          ...info,
          sha256: createHash('sha256').update(cleaned).digest('hex'),
          bytes: cleaned.length,
        },
        null,
        2,
      ) + '\n',
    );
    // 本地展开目录与实际构建读取的归档保持同一份内容。
    const expanded = path.join(snapshotDirectory, 'runtime');
    await rm(expanded, { recursive: true, force: true });
    await cp(output, expanded, { recursive: true, verbatimSymlinks: true });
    console.log('KMH快照已按原版本清理并重新归档。');
    process.exit(0);
  }
  console.log('KMH scening已从项目内快照准备完成。');
  process.exit(0);
}
const sourceRoot = process.env.KMH_SOURCE_ROOT;
if (!sourceRoot?.trim())
  throw new Error(
    '同步内置 Agent 运行时前，请通过 KMH_SOURCE_ROOT 指定上游源码目录。',
  );
const source = path.resolve(sourceRoot);
const nodeBinary = await realpath(
  process.env.KMH_NODE_BINARY ?? process.execPath,
);
if (process.platform === 'darwin') {
  const libraries = execFileSync('otool', ['-L', nodeBinary], {
    encoding: 'utf8',
  });
  if (/\/opt\/|\/usr\/local\/|@rpath/.test(libraries))
    throw new Error(
      '请选择独立Node发行版：通过KMH_NODE_BINARY指定Node 24.9+可执行文件。',
    );
}
const manifest = [];
const visited = new Map();
const workspace = new Map();
const exists = async (file) =>
  stat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

async function resolvePackage(from, name) {
  let directory = from;
  while (true) {
    const candidate = path.join(directory, 'node_modules', name);
    if (await exists(path.join(candidate, 'package.json')))
      return realpath(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) return workspace.get(name);
    directory = parent;
  }
}

async function indexWorkspace(directory) {
  if (await exists(path.join(directory, 'package.json'))) {
    const metadata = JSON.parse(
      await readFile(path.join(directory, 'package.json'), 'utf8'),
    );
    if (metadata.name) workspace.set(metadata.name, directory);
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name))
      await indexWorkspace(path.join(directory, entry.name));
}

async function linkPackage(from, name, target) {
  const link = path.join(from, 'node_modules', name);
  await mkdir(path.dirname(link), { recursive: true });
  if (await exists(link)) return;
  await symlink(path.relative(path.dirname(link), target), link, 'dir');
}

async function copyPackage(directory) {
  const physical = await realpath(directory);
  if (visited.has(physical)) return visited.get(physical);
  const meta = JSON.parse(
    await readFile(path.join(physical, 'package.json'), 'utf8'),
  );
  const id = createHash('sha256').update(physical).digest('hex').slice(0, 12);
  const target = path.join(output, 'packages', id);
  visited.set(physical, target);
  // 原生加载器等按包名动态加载的可选模块沿用安装根的提升解析。
  if (meta.name) await linkPackage(output, meta.name, target);
  const built = await exists(path.join(physical, 'lib'));
  await cp(physical, target, {
    recursive: true,
    dereference: true,
    filter: (file) =>
      includeRuntimeSource(path.relative(physical, file), built),
  });
  manifest.push({ name: meta.name, version: meta.version ?? 'workspace', id });
  const required = { ...meta.dependencies };
  // CLI声明全部官方应用；scening携带编译入口实际导入的CLI依赖。
  // 模型适配器与插件继续复制完整的生产依赖和可选依赖。
  if (
    built &&
    (meta.name?.startsWith('@deepseek-ai/') || meta.name?.startsWith('@kmh/'))
  ) {
    const imported = new Set();
    for (const file of await readdir(path.join(physical, 'lib'), {
      recursive: true,
    })) {
      if (!file.endsWith('.js')) continue;
      const ast = ts.createSourceFile(
        file,
        await readFile(path.join(physical, 'lib', file), 'utf8'),
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
      );
      const visit = (node) => {
        const specifier =
          ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
            ? node.moduleSpecifier
            : ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(node.expression) &&
                    node.expression.text === 'require'))
              ? node.arguments[0]
              : undefined;
        if (specifier && ts.isStringLiteral(specifier)) {
          const name = specifier.text.startsWith('@')
            ? specifier.text.split('/').slice(0, 2).join('/')
            : specifier.text.split('/')[0];
          imported.add(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    if (
      ['@deepseek-ai/dsh', '@deepseek-ai/dsh-official-bundles'].includes(
        meta.name,
      )
    )
      for (const name of Object.keys(required))
        if (!imported.has(name)) delete required[name];
    // 将上游编译文件实际导入、但仅在开发依赖声明的运行包纳入闭包。
    for (const name of imported)
      if (
        workspace.has(name) ||
        Object.hasOwn(meta.devDependencies ?? {}, name)
      )
        required[name] ??= '*';
  }
  const optional = { ...meta.peerDependencies, ...meta.optionalDependencies };
  for (const name of new Set([
    ...Object.keys(required),
    ...Object.keys(optional),
  ])) {
    const dependency = await resolvePackage(physical, name);
    if (!dependency) {
      if (
        Object.hasOwn(required, name) &&
        !Object.hasOwn(meta.optionalDependencies ?? {}, name)
      )
        throw new Error(`KMH生产依赖缺失：${meta.name} -> ${name}`);
      continue;
    }
    await linkPackage(target, name, await copyPackage(dependency));
  }
  return target;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const directory of [
  'packages',
  'third_party/dsh/packages',
  'third_party/dsh/vendor',
  'third_party/dsh/apps',
])
  await indexWorkspace(path.join(source, directory));
const catalog = execFileSync(
  process.execPath,
  [path.join(desktop, 'scripts/export-kmh-catalog.mjs'), source],
  { encoding: 'utf8' },
);
await writeFile(path.join(output, 'catalog.json'), catalog);
const profile = path.join(source, 'profiles/scening');
await cp(profile, path.join(output, 'profile'), {
  recursive: true,
  filter: (file) => includeRuntimeSource(path.relative(profile, file)),
});
const seeds = [
  path.join(source, 'third_party/dsh/apps/cli'),
  path.join(source, 'packages/scene-observer'),
  path.join(source, 'packages/runtime-log'),
];
// scening的逐项插件由其安装目录解析，包含依赖声明之外由运行配置装配的包。
const patch = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
for (const match of patch.matchAll(/name:\s*"([^"]+)"/g)) {
  const name = match[1].startsWith('@')
    ? match[1].split('/').slice(0, 2).join('/')
    : match[1].split('/')[0];
  const dependency =
    (await resolvePackage(profile, name)) ??
    (await resolvePackage(path.join(source, 'third_party/dsh/apps/cli'), name));
  if (!dependency) throw new Error(`scening插件缺失：${name}`);
  seeds.push(dependency);
}
for (const seed of seeds) {
  const meta = JSON.parse(
    await readFile(path.join(seed, 'package.json'), 'utf8'),
  );
  await linkPackage(output, meta.name, await copyPackage(seed));
}
await cp(
  nodeBinary,
  path.join(output, process.platform === 'win32' ? 'node.exe' : 'node'),
);
await cp(
  path.join(desktop, 'scripts/kmh-launcher.mjs'),
  path.join(output, 'kmh.mjs'),
);
await writeFile(
  path.join(output, 'manifest.json'),
  JSON.stringify(
    {
      profile: '@kmh/profile-scening',
      node: execFileSync(nodeBinary, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      platform: process.platform,
      arch: process.arch,
      catalogSha256: createHash('sha256').update(catalog).digest('hex'),
      packages: manifest,
    },
    null,
    2,
  ),
);
console.log(
  `KMH scening已准备：${manifest.length}个生产依赖，${JSON.parse(catalog).catalog.length}个供应商。`,
);
await mkdir(snapshotDirectory, { recursive: true });
await sanitizeRuntimeTree(output);
await createRuntimeArchive(output, snapshotArchive);
const archive = await readFile(snapshotArchive);
await writeFile(
  snapshotInfo,
  JSON.stringify(
    {
      profile: '@kmh/profile-scening',
      platform: process.platform,
      arch: process.arch,
      kmhCommit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      dshCommit: execFileSync(
        'git',
        ['-C', path.join(source, 'third_party/dsh'), 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim(),
      sha256: createHash('sha256').update(archive).digest('hex'),
      bytes: archive.length,
      providers: JSON.parse(catalog).catalog.length,
      packages: manifest.length,
    },
    null,
    2,
  ),
);
console.log(
  `项目内KMH快照已更新：${(archive.length / 1024 / 1024).toFixed(1)} MiB。`,
);
