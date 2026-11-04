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
  templates?: { base: string; publish: string },
  userHome = homedir(),
) {
  const basePath = path.join(root, 'observer.yaml');
  if (mode === 'dev')
    return {
      configPath: explicitConfig
        ? resolveConfiguredPath(basePath, explicitConfig, userHome)
        : basePath,
      cacheRoot: path.join(root, 'desktop/.cache'),
      logRoot: path.join(root, 'logs'),
    };

  let configPath: string;
  if (explicitConfig) {
    configPath = resolveConfiguredPath(basePath, explicitConfig, userHome);
  } else {
    const [baseContent, publishContent] = templates
      ? [templates.base, templates.publish]
      : await Promise.all([
          readFile(basePath, 'utf8'),
          readFile(path.join(root, 'observer.publish.yaml'), 'utf8'),
        ]);
    const profileRaw: unknown = document(publishContent).toJS();
    const profile = LocationsSchema.parse(profileRaw);
    const home = resolveConfiguredPath(basePath, profile.home, userHome);
    resolveConfiguredPath(basePath, profile.screenshotDir, userHome);
    configPath = path.join(home, 'observer.yaml');
    const base = document(baseContent);
    const baseRaw: unknown = base.toJS();
    const launcher = LauncherSchema.parse(baseRaw);
    base.set('home', profile.home);
    base.set('screenshotDir', profile.screenshotDir);
    base.set(
      'kmhLauncher',
      resolveConfiguredPath(basePath, launcher.kmhLauncher, userHome),
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    try {
      await writeFile(configPath, base.toString(), { flag: 'wx', mode: 0o600 });
    } catch (error: unknown) {
      if (ErrorCodeSchema.safeParse(error).data?.code !== 'EEXIST') throw error;
    }
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
