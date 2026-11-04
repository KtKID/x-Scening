import { z } from 'zod';

export const RuntimeModeSchema = z.enum(['dev', 'publish']);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

/** 模式由构建环境确定；本地构建默认dev，GitHub Release或tag构建使用publish。 */
export function resolveBuildMode(env: NodeJS.ProcessEnv): RuntimeMode {
  return RuntimeModeSchema.parse(
    env.OBSERVER_BUILD_MODE ??
      (env.GITHUB_ACTIONS === 'true' &&
      (env.GITHUB_EVENT_NAME === 'release' || env.GITHUB_REF_TYPE === 'tag')
        ? 'publish'
        : 'dev'),
  );
}
