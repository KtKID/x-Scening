import { z } from 'zod';
import type { ModelSettings, ModelSelection, SaveProvider } from './models';
import type { LocalBuildStatus } from '../version-check/protocol';
import {
  ActivityEventSchema,
  ActivitySummarySchema,
  ObserverConfigSchema,
  DesktopConfigSchema,
  DailyReviewSchema,
  type DailyReviewViewSchema,
  DailyReviewPresentedSchema,
  type DailyReviewReplySchema,
  type TimelineReadReplySchema,
  type BackfillStatusSchema,
} from './scening.generated';

export const SourceSchema = z.enum(['demo', 'local']);
export const EditableConfigSchema = ObserverConfigSchema.omit({
  _comments: true,
}).extend({ desktop: DesktopConfigSchema });
export const SettingsSnapshotSchema = z.strictObject({
  config: EditableConfigSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const SaveSettingsSchema = SettingsSnapshotSchema;
export type EditableConfig = z.infer<typeof EditableConfigSchema>;
export type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;
export const TaskTypePresetsSchema = ObserverConfigSchema.pick({
  taskTypes: true,
});
export const PresetSnapshotSchema = TaskTypePresetsSchema.extend({
  configPath: z.string().min(1),
});
export type TaskTypePresets = z.infer<typeof TaskTypePresetsSchema>;
export type PresetSnapshot = z.infer<typeof PresetSnapshotSchema>;
export const DaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, '日期无效');
export const QuerySchema = z.strictObject({
  day: DaySchema,
  source: SourceSchema,
});
export const BackfillQuerySchema = z.strictObject({ day: DaySchema });
export const ScreenshotDirectoryActionSchema = z.enum(['read', 'open']);
export const ScreenshotDirectorySchema = z.string().min(1);
export const BackfillActionSchema = BackfillQuerySchema.extend({
  action: z.enum(['start', 'stop']),
});
export type BackfillStatus = z.infer<typeof BackfillStatusSchema>;
export type BackfillQuery = z.infer<typeof BackfillQuerySchema>;
export type BackfillAction = z.infer<typeof BackfillActionSchema>;
export const TaskTimelineQuerySchema = QuerySchema.extend({
  expectedSourceRevision: z.string().default(''),
  refreshReason: z.enum(['auto', 'manual']).default('auto'),
});
export type TaskTimelineQuery = z.infer<typeof TaskTimelineQuerySchema>;
export const TaskSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('segment'),
    day: DaySchema,
    source: SourceSchema,
    taskId: z.string().nullable(),
    segmentId: z.string(),
    activityId: z.string().nullable(),
    timeAnchor: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal('range'),
    day: DaySchema,
    source: SourceSchema,
    sliceId: z.string(),
    start: z.string(),
    end: z.string(),
    segmentId: z.string().nullable(),
  }),
]);
export const TimelineActivitySchema = ActivityEventSchema.extend({
  id: z.string().min(1),
  title: z.string().min(1),
});
export const SnapshotSchema = z.strictObject({
  day: DaySchema,
  source: SourceSchema,
  activities: z.array(TimelineActivitySchema),
  sourceRevision: z.string().default(''),
  summaries: z.array(ActivitySummarySchema),
  issues: z.array(z.string()),
  locations: z.strictObject({
    configPath: z.string(),
    home: z.string(),
    screenshotDir: z.string(),
  }),
});
export const DailyReviewQuerySchema = QuerySchema.extend({
  refresh: z.boolean(),
  /** 只读已保存日文件：缺文件返回空态，不触发生成；生成仅由显式按钮发起。 */
  cachedOnly: z.boolean().default(false),
});
/** 调用方视角的查询：cachedOnly 可省略，解析后统一补默认值。 */
export type DailyReviewQuery = z.input<typeof DailyReviewQuerySchema>;
export type DailyReviewReply = z.infer<typeof DailyReviewReplySchema>;
export const DailyReviewDayQuerySchema = QuerySchema.pick({ day: true });
export const DailyReviewGenerateQuerySchema = DailyReviewPresentedSchema.omit({
  revision: true,
}).extend({ day: DaySchema });
export const DailyReviewPresentedQuerySchema =
  DailyReviewPresentedSchema.extend({ day: DaySchema });
export type DailyReviewView = z.infer<typeof DailyReviewViewSchema>;

/** 档案是本次阅读/导出的只读快照；原回顾与活动仍由Python维护。 */
export const DailyArchiveSchema = z.strictObject({
  source: SourceSchema,
  review: DailyReviewSchema,
  statistics: z.strictObject({
    capturedAt: z.iso.datetime({ offset: true }),
    activityCount: z.number().int().nonnegative(),
    appCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative().nullable(),
    pendingTasks: z.boolean(),
    categories: z.array(
      z.strictObject({
        name: z.string().min(1),
        count: z.number().int().positive(),
      }),
    ),
    issues: z.array(z.string()),
  }),
});
export type DailyArchive = z.infer<typeof DailyArchiveSchema>;
export const ArchiveImageReplySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('saved'), path: z.string().min(1) }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({ status: z.literal('error'), message: z.string() }),
]);
export type ArchiveImageReply = z.infer<typeof ArchiveImageReplySchema>;

export const ImageQuerySchema = z.strictObject({
  id: z.string().min(1),
  frameIndex: z.number().int().positive().optional(),
});
export const ImageResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    dataUrl: z.string().startsWith('data:image/'),
  }),
  z.strictObject({ status: z.literal('missing'), message: z.string() }),
]);

export type Source = z.infer<typeof SourceSchema>;
export type Query = z.infer<typeof QuerySchema>;
export type TimelineActivity = z.infer<typeof TimelineActivitySchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type ImageResult = z.infer<typeof ImageResultSchema>;
export const CaptureModeSchema = z.enum(['full', 'capture-only']);
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export const CaptureStateSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.enum(['stopped', 'error', 'unsupported']),
    message: z.string(),
  }),
  z.strictObject({
    state: z.enum(['starting', 'running', 'stopping']),
    pid: z.number().int().positive(),
    origin: z.enum(['client', 'external']),
    mode: CaptureModeSchema,
    message: z.string(),
  }),
]);
export const CaptureActionSchema = z.enum([
  'start',
  'stop',
  'enable-analysis',
  'disable-analysis',
]);
export const RuntimeSnapshotSchema = z.strictObject({
  capture: CaptureStateSchema,
  analysisEnabled: z.boolean(),
  refreshIntervalSeconds: z.number().positive(),
  revision: z.number().int().nonnegative().default(0),
});
export type CaptureState = z.infer<typeof CaptureStateSchema>;
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;
export type CaptureAction = z.infer<typeof CaptureActionSchema>;
/** 独立后台作业的只读快照；采集与实时分析仍由 RuntimeSnapshot 表达。 */
export const BackgroundsReplySchema = z.strictObject({
  organizing: z.strictObject({
    running: z.boolean(),
    day: DaySchema.nullable(),
  }),
  backfill: z.strictObject({
    running: z.boolean(),
    activeDay: DaySchema.nullable(),
  }),
});
export type BackgroundsReply = z.infer<typeof BackgroundsReplySchema>;
export type ObserverBridge = {
  readModelSettings: () => Promise<ModelSettings>;
  saveModelProvider: (request: SaveProvider) => Promise<ModelSettings>;
  selectModel: (request: ModelSelection) => Promise<ModelSettings>;
  removeModelProvider: (provider: string) => Promise<ModelSettings>;
  readDailyReviewState: (
    query: z.infer<typeof DailyReviewDayQuerySchema>,
  ) => Promise<DailyReviewView>;
  generateDailyReview: (
    query: z.infer<typeof DailyReviewGenerateQuerySchema>,
  ) => Promise<DailyReviewView>;
  markDailyReviewPresented: (
    query: z.infer<typeof DailyReviewPresentedQuerySchema>,
  ) => Promise<DailyReviewView>;
  onDailyReviewOpen: (listener: (view: DailyReviewView) => void) => () => void;
  onDailyReviewChanged: (
    listener: (view: DailyReviewView) => void,
  ) => () => void;

  readLocalBuild: () => Promise<LocalBuildStatus>;
  restartLocalClient: () => Promise<void>;
  onLocalBuild: (listener: (status: LocalBuildStatus) => void) => () => void;
  saveArchiveImage: (archive: DailyArchive) => Promise<ArchiveImageReply>;
  readBackfill: (query: BackfillQuery) => Promise<BackfillStatus>;
  controlBackfill: (request: BackfillAction) => Promise<BackfillStatus>;
  screenshotDirectory: (
    action: z.infer<typeof ScreenshotDirectoryActionSchema>,
  ) => Promise<z.infer<typeof ScreenshotDirectorySchema>>;
  readSettings: () => Promise<SettingsSnapshot>;
  saveSettings: (settings: SettingsSnapshot) => Promise<SettingsSnapshot>;
  readPresets: () => Promise<PresetSnapshot>;
  savePresets: (presets: TaskTypePresets) => Promise<PresetSnapshot>;
  readDailyReview: (query: DailyReviewQuery) => Promise<DailyReviewReply>;
  readTaskTimeline: (
    query: TaskTimelineQuery,
  ) => Promise<z.infer<typeof TimelineReadReplySchema>>;
  readDay: (query: Query) => Promise<Snapshot>;
  readImage: (id: string, frameIndex?: number) => Promise<ImageResult>;
  readRuntime: () => Promise<RuntimeSnapshot>;
  readBackgrounds: () => Promise<BackgroundsReply>;
  controlCapture: (action: CaptureAction) => Promise<RuntimeSnapshot>;
  onRuntime: (listener: (runtime: RuntimeSnapshot) => void) => () => void;
};

export function localDay(date = new Date()): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function moveDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return localDay(date);
}

export function clock(value: string): string {
  // 屏幕观察的原始本地时区决定时间线位置；跨机器查看仍沿用记录中的钟点。
  return value.slice(11, 16);
}

export function minutes(value: string): number {
  return Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
}
