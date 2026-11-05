import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ObserverConfigSchema } from '../shared/scening.generated';
import type { RuntimeMode } from '../runtime-mode';
import { resolveConfiguredPath } from './config-paths';

const LocationsSchema = ObserverConfigSchema.pick({
  home: true,
  screenshotDir: true,
}).strip();
const LauncherSchema = ObserverConfigSchema.pick({ kmhLauncher: true }).strip();
const ErrorCodeSchema = z.object({ code: z.string() });

function document(content: string) {
  const parsed = parseDocument(content, { uniqueKeys: true });
  if (parsed.errors.length)
    throw new Error(parsed.errors.map((error) => error.message).join('；'));
  return parsed;
}

/** 按构建模式准备配置和写入目录；首次发布排他创建配置，后续读取用户原文。 */
export async function prepareRuntimePaths(
  root: string,
  mode: RuntimeMode,
  explicitConfig?: string,
  publishTemplate?: string,
  userHome = homedir(),
) {
  const basePath = path.join(root, 'observer.yaml');
  if (mode === 'dev') {
    return {
      configPath: explicitConfig
        ? resolveConfiguredPath(basePath, explicitConfig, userHome)
        : await prepareDevConfig(basePath),
      cacheRoot: path.join(root, 'desktop/.cache'),
      logRoot: path.join(root, 'logs'),
    };
  }

  let configPath: string;
  if (explicitConfig) {
    configPath = resolveConfiguredPath(basePath, explicitConfig, userHome);
  } else {
    const template = document(
      publishTemplate ?? (await readFile(basePath, 'utf8')),
    );
    const raw: unknown = template.toJS();
    const locations = LocationsSchema.parse(raw);
    const home = resolveConfiguredPath(basePath, locations.home, userHome);
    resolveConfiguredPath(basePath, locations.screenshotDir, userHome);
    configPath = path.join(home, 'observer.yaml');
    const launcher = LauncherSchema.parse(raw);
    template.set(
      'kmhLauncher',
      resolveConfiguredPath(basePath, launcher.kmhLauncher, userHome),
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    await createConfig(configPath, template.toString());
  }
  const raw: unknown = document(await readFile(configPath, 'utf8')).toJS();
  const locations = LocationsSchema.parse(raw);
  const home = resolveConfiguredPath(configPath, locations.home, userHome);
  return {
    configPath,
    cacheRoot: path.join(home, 'desktop/.cache'),
    logRoot: path.join(home, 'logs'),
  };
}

/** 开发配置首次生成后由用户维护；自定义项目根兼容原有独立配置。 */
async function prepareDevConfig(basePath: string): Promise<string> {
  const root = path.dirname(basePath);
  const configPath = path.join(root, 'observer_dev.yaml');
  try {
    await readFile(configPath, 'utf8');
    return configPath;
  } catch (error: unknown) {
    if (ErrorCodeSchema.safeParse(error).data?.code !== 'ENOENT') throw error;
  }
  let devTemplate: string;
  try {
    devTemplate = await readFile(
      path.join(root, 'observer.defaults_dev.yaml'),
      'utf8',
    );
  } catch (error: unknown) {
    if (ErrorCodeSchema.safeParse(error).data?.code !== 'ENOENT') throw error;
    return basePath;
  }
  const raw: unknown = document(devTemplate).toJS();
  const locations = LocationsSchema.parse(raw);
  const template = document(await readFile(basePath, 'utf8'));
  template.set('home', locations.home);
  template.set('screenshotDir', locations.screenshotDir);
  await createConfig(configPath, template.toString());
  return configPath;
}

async function createConfig(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: 'wx', mode: 0o600 });
  } catch (error: unknown) {
    if (ErrorCodeSchema.safeParse(error).data?.code !== 'EEXIST') throw error;
  }
}

/** 从正在运行的主进程定位源码预览或固定目录下的本地构建。 */
export function resolveSourceRoot(
  mainDirectory: string,
  packaged: boolean,
  platform: NodeJS.Platform,
): string {
  if (!packaged) return path.resolve(mainDirectory, '../../..');
  return path.resolve(
    mainDirectory,
    platform === 'darwin'
      ? '../../../../../../../../..'
      : '../../../../../../..',
  );
}
