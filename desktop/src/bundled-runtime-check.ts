import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** 真实启动应用自带的Python和KMH；独占home在结束后清理，故障阻止构建与发布。 */
export async function verifyBundledRuntimes(resources: string): Promise<void> {
  const pythonRoot = path.join(resources, 'python-runtime');
  const kmhRoot = path.join(resources, 'kmh-runtime');
  try {
    await Promise.all([
      readFile(path.join(pythonRoot, 'src/scening/observer_config.py')),
      readFile(path.join(kmhRoot, 'catalog.json')),
      readFile(path.join(kmhRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')),
    ]);
    const home = await mkdtemp(path.join(tmpdir(), 'scening-runtime-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONPATH: path.join(pythonRoot, 'src'),
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      SCENING_LOG_DIR: path.join(home, 'logs'),
      KMH_HOME: path.join(home, 'kmh'),
      DSH_TELEMETRY_DISABLED: '1',
    };
    delete env.PYTHONHOME;
    try {
      await execute(
        path.join(pythonRoot, '.venv/bin/python'),
        [
          '-B',
          '-c',
          'import sys,pathlib,PIL,pydantic,yaml,mss,pynput,Quartz,Vision; from scening.observer_config import load_config,DEFAULT_CONFIG_PATH; root=pathlib.Path(sys.argv[1]).resolve(); assert pathlib.Path(sys.prefix).resolve().is_relative_to(root); assert DEFAULT_CONFIG_PATH.is_relative_to(root); load_config(DEFAULT_CONFIG_PATH); print("Python/scening ready")',
          pythonRoot,
        ],
        { cwd: home, env, timeout: 45000 },
      );
      const dump = await execute(
        path.join(kmhRoot, 'node'),
        [
          path.join(kmhRoot, 'kmh.mjs'),
          'dsh',
          '--profile',
          'scening',
          '--dump-config',
        ],
        { cwd: home, env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 },
      );
      if (!dump.stdout.includes('@kmh/scene-observer'))
        throw new Error('KMH scening插件展开失败。');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } catch (cause: unknown) {
    throw new Error('内置Python/KMH运行环境核验失败。', { cause });
  }
}
