import path from 'node:path';
import type { RuntimeMode } from '../runtime-mode';

/** 发布安装包从自身资源定位后端；开发启动沿用项目目录与显式覆盖。 */
export function resolveApplicationRoot(
  sourceRoot: string,
  resources: string,
  packaged: boolean,
  mode: RuntimeMode,
): string {
  return packaged && mode === 'publish'
    ? path.join(resources, 'python-runtime')
    : sourceRoot;
}
