import { execFileSync, spawn } from 'node:child_process';
import { verifyBundledRuntimes } from '../bundled-runtime-check';
import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { resolveBuildMode } from '../runtime-mode';
import { LOCAL_BUILD_MARKER, LocalBuildInfoSchema } from './protocol';
import type { LocalBuildInfo } from './protocol';
import { localClientPaths } from './paths';

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** 独占本地构建；上次进程退出后清理遗留锁，活动构建保持独占。 */
async function lockBuild(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const create = async () => {
    const lock = await open(file, 'wx');
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      return lock;
    } catch (error: unknown) {
      await lock.close();
      await rm(file, { force: true });
      throw error;
    }
  };
  try {
    return await create();
  } catch (error: unknown) {
    if (!isCode(error, 'EEXIST')) throw error;
    const owner = z
      .strictObject({ pid: z.number().int().positive() })
      .parse(JSON.parse(await readFile(file, 'utf8')));
    try {
      process.kill(owner.pid, 0);
    } catch (probe: unknown) {
      if (isCode(probe, 'ESRCH')) {
        await rm(file);
        return create();
      }
    }
    throw new Error('已有客户端构建正在运行，请等待该次构建完成。');
  }
}

async function writeMarker(file: string, build: LocalBuildInfo): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(build)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 编译、打包、固定入口发布成功后写标记；失败恢复上一份应用。
 * root为项目根，compile与assemble分别生成out及指定暂存目录中的完整应用。
 * 仅完整且含本轮编译结果的应用可以发布；正式记录保持原有写入归属。
 */
export async function publishLocalBuild(
  root: string,
  build: LocalBuildInfo,
  compile: (build: LocalBuildInfo) => Promise<void>,
  assemble: (output: string) => Promise<void>,
  finalize?: (app: string) => Promise<void>,
): Promise<void> {
  const validated = LocalBuildInfoSchema.parse(build);
  const cache = path.join(root, 'desktop/.cache');
  const lockPath = path.join(cache, 'client-build.lock.json');
  const lock = await lockBuild(lockPath);
  const staging = path.join(cache, 'client-package-stage');
  const previous = path.join(cache, 'client-package-previous');
  const target = localClientPaths(root);
  const staged = localClientPaths(root, staging);
  const backup = localClientPaths(root, previous);
  try {
    await rm(staging, { recursive: true, force: true });
    await compile(validated);
    const output = path.join(root, 'desktop/out');
    const compiled = await Promise.all(
      ['main/index.js', 'preload/index.cjs', 'renderer/index.html'].map(
        (file) => readFile(path.join(output, file)),
      ),
    );
    if (
      !compiled[0]?.includes(Buffer.from(validated.buildId)) ||
      compiled.some((content) => !content.toString().trim())
    )
      throw new Error('本轮客户端编译产物尚未完整就绪。');
    await assemble(staging);
    const archive = await readFile(staged.archive);
    if (
      !(await stat(staged.executable)).isFile() ||
      !compiled.every((content) => archive.includes(content))
    )
      throw new Error('应用包中的客户端产物与本轮编译结果不一致。');
    await writeMarker(staged.info, validated);
    await finalize?.(staged.app);
    // 首次改名沿用原应用目录身份；旧入口软链接让运行中的旧版继续更新。
    if (process.platform === 'darwin') {
      try {
        await stat(target.app);
      } catch (error: unknown) {
        if (!isCode(error, 'ENOENT')) throw error;
        const legacy = path.join(path.dirname(target.app), 'Observer.app');
        try {
          if ((await lstat(legacy)).isDirectory()) {
            await rename(legacy, target.app);
            await symlink(path.basename(target.app), legacy);
          }
        } catch (migration: unknown) {
          if (!isCode(migration, 'ENOENT')) throw migration;
        }
      }
    }
    await mkdir(path.dirname(target.payload), { recursive: true });
    await rm(previous, { recursive: true, force: true });
    await mkdir(path.dirname(backup.payload), { recursive: true });
    let previousMoved = false;
    let promoted = false;
    try {
      try {
        await rename(target.payload, backup.payload);
        previousMoved = true;
      } catch (error: unknown) {
        if (!isCode(error, 'ENOENT')) throw error;
      }
      await rename(staged.payload, target.payload);
      promoted = true;
      await writeMarker(path.join(root, LOCAL_BUILD_MARKER), validated);
    } catch (error: unknown) {
      try {
        if (promoted)
          await rm(target.payload, { recursive: true, force: true });
        if (previousMoved) await rename(backup.payload, target.payload);
      } catch (recovery: unknown) {
        throw new AggregateError(
          [error, recovery],
          '客户端发布失败，恢复上一份应用时也发生错误。',
        );
      }
      throw error;
    }
  } finally {
    try {
      await rm(staging, { recursive: true, force: true });
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }
}

async function runTool(
  desktop: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  executable = process.execPath,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: desktop,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`客户端构建退出码：${String(code)}`)),
    );
  });
}

/** 唯一手动构建入口：完成应用发布后才向运行客户端发布成功标记。 */
async function buildLocalClient(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      'output-root': { type: 'string' },
      'apple-development-identity': { type: 'string' },
    },
  });
  const mode = resolveBuildMode({
    ...process.env,
    ...(values.mode === undefined ? {} : { OBSERVER_BUILD_MODE: values.mode }),
  });
  const appleDevelopmentIdentity =
    values['apple-development-identity']?.toUpperCase();
  if (appleDevelopmentIdentity !== undefined) {
    if (process.platform !== 'darwin')
      throw new Error('Apple Development 签名适用于 macOS 打包。');
    if (!/^[0-9A-F]{40}$/.test(appleDevelopmentIdentity))
      throw new Error('请提供 Apple Development 证书的 40 位 SHA-1 指纹。');
    const identities = execFileSync(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8' },
    ).matchAll(/^\s*\d+\) ([0-9A-F]{40}) "Apple Development: [^\r\n]+"$/gm);
    if (![...identities].some(([, hash]) => hash === appleDevelopmentIdentity))
      throw new Error(
        '钥匙串里找不到指定的有效 Apple Development 签名证书和私钥。',
      );
  }
  const root = path.resolve(
    fileURLToPath(new URL('../../..', import.meta.url)),
  );
  const desktop = path.join(root, 'desktop');
  const outputRoot = values['output-root']
    ? path.resolve(values['output-root'])
    : root;
  const metadata: unknown = JSON.parse(
    await readFile(path.join(desktop, 'package.json'), 'utf8'),
  );
  const { version } = z
    .object({ version: LocalBuildInfoSchema.shape.version })
    .parse(metadata);
  const build = LocalBuildInfoSchema.parse({
    buildId: randomUUID(),
    version,
    createdAt: new Date().toISOString(),
  });
  await publishLocalBuild(
    outputRoot,
    build,
    async (info) => {
      await runTool(
        desktop,
        [
          path.join(desktop, 'node_modules/electron-vite/bin/electron-vite.js'),
          'build',
        ],
        {
          ...process.env,
          OBSERVER_BUILD_MODE: mode,
          OBSERVER_LOCAL_BUILD_INFO: JSON.stringify(info),
        },
      );
      if (outputRoot !== root) {
        const output = path.join(outputRoot, 'desktop/out');
        await rm(output, { recursive: true, force: true });
        await cp(path.join(desktop, 'out'), output, { recursive: true });
      }
    },
    async (output) => {
      await runTool(
        desktop,
        [path.join(desktop, 'scripts/prepare-kmh.mjs')],
        process.env,
      );
      if (mode === 'publish')
        await runTool(
          desktop,
          [path.join(desktop, 'scripts/prepare-python.mjs')],
          process.env,
        );
      else if (process.platform === 'darwin')
        await runTool(
          desktop,
          ['-B', path.join(root, 'src/scening/screen_stream.py')],
          process.env,
          path.join(root, '.venv/bin/python'),
        );
      await runTool(
        desktop,
        [
          path.join(desktop, 'node_modules/electron-builder/cli.js'),
          '--dir',
          `--config.electronDist=${path.join(desktop, 'node_modules/electron/dist')}`,
          `--config.directories.output=${output}`,
        ],
        process.env,
      );
      if (process.platform === 'darwin') {
        const app = localClientPaths(root, output).app;
        // 包内依赖与Node在写成功标记前完成真实启动；资源复制遗漏在此阻止发布。
        const runtime = path.join(app, 'Contents/Resources/kmh-runtime');
        await readFile(
          path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
        );
        const smokeHome = path.join(output, 'kmh-smoke-home');
        try {
          await runTool(
            desktop,
            [
              path.join(runtime, 'kmh.mjs'),
              'dsh',
              '--profile',
              'scening',
              '--dump-config',
            ],
            {
              ...process.env,
              KMH_HOME: smokeHome,
              DSH_TELEMETRY_DISABLED: '1',
            },
            path.join(runtime, 'node'),
          );
        } finally {
          await rm(smokeHome, { recursive: true, force: true });
        }
        if (mode === 'publish')
          await verifyBundledRuntimes(path.join(app, 'Contents/Resources'));
      }
    },
    process.platform === 'darwin' &&
      (mode === 'publish' || appleDevelopmentIdentity !== undefined)
      ? async (app) => {
          // 先签 Electron 的内嵌代码，再封存应用资源和本轮构建标记。
          const frameworks = path.join(app, 'Contents/Frameworks');
          const components = await readdir(frameworks);
          await runTool(
            desktop,
            [
              '--force',
              '--sign',
              appleDevelopmentIdentity ?? '-',
              '--timestamp=none',
              '--preserve-metadata=entitlements',
              ...components.map((name) => path.join(frameworks, name)),
              app,
            ],
            process.env,
            '/usr/bin/codesign',
          );
          await runTool(
            desktop,
            ['--verify', '--deep', '--strict', app],
            process.env,
            '/usr/bin/codesign',
          );
        }
      : undefined,
  );
  console.log(
    `客户端已就绪：v${build.version} · ${mode} · ${localClientPaths(outputRoot).app}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildLocalClient();
