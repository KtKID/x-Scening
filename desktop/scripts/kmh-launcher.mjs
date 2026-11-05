// 内置KMH入口；使用应用资源中的DSH和scening，运行数据继续写入KMH_HOME。
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.KMH_HOME;
if (!home || !path.isAbsolute(home)) throw new Error('KMH_HOME需要绝对路径。');
const directory = path.join(home, 'profiles/x-scening-bundled');
await mkdir(directory, { recursive: true });
for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
  const content = await readFile(path.join(root, 'profile', file));
  await writeFile(path.join(directory, file), content);
}
// profile声明的插件从资源目录解析；资源移动后更新本应用独占的依赖链接。
const modules = path.join(directory, 'node_modules');
const target = path.join(root, 'node_modules');
let linked = false;
try {
  if (!(await lstat(modules)).isSymbolicLink())
    throw new Error('内置scening依赖位置已被占用。');
  linked = (await readlink(modules)) === target;
  if (!linked) await unlink(modules);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!linked) await symlink(target, modules, 'dir');
const args = process.argv.slice(2);
if (args.shift() !== 'dsh') throw new Error('内置KMH仅提供dsh scening入口。');
const position = args.indexOf('--profile');
if (position < 0 || args[position + 1] !== 'scening')
  throw new Error('内置KMH需要scening profile。');
args[position + 1] = 'x-scening-bundled';
const child = spawn(
  process.execPath,
  [path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ...args],
  {
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: home },
  },
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('kmh: 内置运行时启动失败');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
