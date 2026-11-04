import { z } from 'zod';

/** 本机版本检查的固定周期，单位毫秒。 */
export const LOCAL_BUILD_CHECK_INTERVAL_MS = 60_000;
export const LOCAL_BUILD_MARKER = 'desktop/.cache/local-client-build.json';

/** 构建前生成并嵌入主进程，完整编译成功后发布同一标识。 */
export const LocalBuildInfoSchema = z.strictObject({
  buildId: z.uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  createdAt: z.iso.datetime(),
});
export type LocalBuildInfo = z.infer<typeof LocalBuildInfoSchema>;
export const LocalBuildStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('current'),
    running: LocalBuildInfoSchema,
  }),
  z.strictObject({
    status: z.literal('available'),
    running: LocalBuildInfoSchema,
    latest: LocalBuildInfoSchema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    running: LocalBuildInfoSchema,
  }),
]);
export type LocalBuildStatus = z.infer<typeof LocalBuildStatusSchema>;
