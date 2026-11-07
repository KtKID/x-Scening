// 将独立Python、带哈希生产依赖及scening源码准备成可迁移的应用资源目录。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePythonRuntime } from './stage-python-runtime.mjs';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const cache = path.join(desktop, '.cache');
const builder = path.join(cache, 'python-builder');
const output = path.join(cache, 'python-runtime');
const uvVersion = '0.9.18';
const pythonVersion = '3.12.11';
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('独立Python运行环境当前支持macOS arm64。');
const bootstrap =
  process.env.SCENING_BUILD_PYTHON ?? path.join(root, '.venv/bin/python');
const builderPython = path.join(builder, 'bin/python');
const env = {
  ...process.env,
  UV_CACHE_DIR: path.join(cache, 'uv'),
  UV_PYTHON_INSTALL_DIR: path.join(cache, 'python-toolchains'),
  UV_PYTHON_BIN_DIR: path.join(cache, 'python-bin'),
  UV_NO_PROGRESS: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
};
delete env.PYTHONHOME;
delete env.PYTHONPATH;
const run = (exe, args) =>
  execFileSync(exe, args, { cwd: root, env, stdio: 'inherit' });
await mkdir(cache, { recursive: true });
try {
  await readFile(path.join(builder, 'pyvenv.cfg'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  run(bootstrap, ['-m', 'venv', builder]);
}
let installedUv = '';
try {
  installedUv = execFileSync(builderPython, ['-m', 'uv', '--version'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  /* 首次构建安装固定工具版本。 */
}
if (
  !installedUv.startsWith(`uv ${uvVersion} `) &&
  installedUv !== `uv ${uvVersion}`
)
  run(builderPython, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    `uv==${uvVersion}`,
  ]);
const uv = (args) => run(builderPython, ['-m', 'uv', ...args]);
uv(['python', 'install', '--no-bin', pythonVersion]);
const lock = path.join(desktop, 'requirements-runtime.lock');
const lockHash = createHash('sha256')
  .update(await readFile(lock))
  .digest('hex');
const stamp = JSON.stringify({ pythonVersion, uvVersion, lockHash });
let reusable = false;
try {
  reusable =
    (await readFile(path.join(output, 'dependencies.json'), 'utf8')) === stamp;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!reusable) {
  const installs = await readdir(env.UV_PYTHON_INSTALL_DIR);
  const install = installs.find(
    (name) => name === `cpython-${pythonVersion}-macos-aarch64-none`,
  );
  if (!install) throw new Error('独立Python安装目录与目标版本不符。');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(
    path.join(env.UV_PYTHON_INSTALL_DIR, install),
    path.join(output, '.venv'),
    { recursive: true, verbatimSymlinks: true },
  );
  uv([
    'pip',
    'install',
    '--python',
    path.join(output, '.venv/bin/python3'),
    '--system',
    '--break-system-packages',
    '--require-hashes',
    '--only-binary',
    ':all:',
    '-r',
    lock,
  ]);
  // 现有后端入口统一使用.venv/bin/python，独立发行版同时提供该相对链接。
  await writeFile(path.join(output, 'dependencies.json'), stamp);
}
await rm(path.join(output, 'src'), { recursive: true, force: true });
await mkdir(path.join(output, 'src'), { recursive: true });
await cp(path.join(root, 'src/scening'), path.join(output, 'src/scening'), {
  recursive: true,
  filter: (file) =>
    !file.split(path.sep).includes('__pycache__') && !file.endsWith('.pyc'),
});
await stagePythonRuntime(root, output, pythonVersion, env);
run(path.join(output, '.venv/bin/python'), [
  '-B',
  path.join(output, 'src/scening/screen_stream.py'),
  '--bundled',
]);
run(path.join(output, '.venv/bin/python'), [
  '-B',
  '-c',
  'import sys, PIL, pydantic, yaml, mss, pynput, Quartz, Vision; print("内置Python依赖检查通过", sys.version.split()[0])',
]);
console.log('独立Python与scening已准备完成。');
