import { homedir } from 'node:os';
import path from 'node:path';

/** 展开当前用户的~路径；其余相对路径按配置文件所在目录解析。 */
export function resolveConfiguredPath(
  configPath: string,
  value: string,
  userHome = homedir(),
): string {
  if (!value.trim()) throw new Error('配置路径应有内容');
  const expanded =
    value === '~'
      ? userHome
      : value.startsWith('~/')
        ? path.join(userHome, value.slice(2))
        : value;
  return path.resolve(path.dirname(configPath), expanded);
}
