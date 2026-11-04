import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** 等待当前进程结束后由LaunchServices启动完整应用包；保留项目配置与启动日志。 */
export async function scheduleMacRestart(
  application: string,
  root: string,
  args: string[],
  config?: string,
): Promise<void> {
  const folder = path.join(root, 'desktop/.cache');
  await mkdir(folder, { recursive: true });
  const log = openSync(path.join(folder, 'restart.log'), 'a', 0o600);
  try {
    writeSync(log, `${new Date().toISOString()} restart scheduled\n`);
    const launch = [
      '-n',
      application,
      '--env',
      `OBSERVER_PROJECT_ROOT=${root}`,
    ];
    if (config) launch.push('--env', `OBSERVER_CONFIG=${config}`);
    if (args.length) launch.push('--args', ...args);
    // 所有动态值通过位置参数传递，避免路径中的空格和shell字符被解释。
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.1; done; shift; exec /usr/bin/open "$@"',
        'x-scening-restart',
        String(process.pid),
        ...launch,
      ],
      { detached: true, stdio: ['ignore', log, log] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}
