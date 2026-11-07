// 自动生成：权威源 src/scening 的 Pydantic 模型（activity_memory、observer_config、runtime_control、daily_review、task_models、screenshot_backfill_status）。
// 修改模型后运行 ./scripts/run.sh run contracts；contracts:check 检查漂移。
import { z } from 'zod';

export const DailyReviewDiagnosticSchema = z.strictObject({
  source: z.string(),
  occurredAt: z.iso.datetime({ offset: true }),
  message: z.string().min(1),
  details: z.string(),
  code: z.union([z.string(), z.null()]).optional().default(null),
  exitCode: z.union([z.number().int(), z.null()]).optional().default(null),
  signal: z.union([z.string(), z.null()]).optional().default(null),
});

export const DailyReviewStateSchema = z.strictObject({
  schemaVersion: z.literal(1).optional().default(1),
  day: z.string(),
  phase: z
    .enum([
      'scheduled',
      'running',
      'waiting_retry',
      'succeeded',
      'empty',
      'failed',
    ])
    .optional()
    .default('scheduled'),
  attemptId: z.union([z.string(), z.null()]).optional().default(null),
  trigger: z
    .union([z.enum(['automatic', 'manual']), z.null()])
    .optional()
    .default(null),
  startedAt: z
    .union([z.iso.datetime({ offset: true }), z.null()])
    .optional()
    .default(null),
  finishedAt: z
    .union([z.iso.datetime({ offset: true }), z.null()])
    .optional()
    .default(null),
  autoAttempts: z.number().int().min(0).optional().default(0),
  autoExhausted: z.boolean().optional().default(false),
  nextAttemptAt: z
    .union([z.iso.datetime({ offset: true }), z.null()])
    .optional()
    .default(null),
  lastError: z
    .union([DailyReviewDiagnosticSchema, z.null()])
    .optional()
    .default(null),
  presentedOn: z.union([z.string(), z.null()]).optional().default(null),
});

export const DailyReviewSchema = z.strictObject({
  day: z.string().regex(new RegExp('^\\d{4}-\\d{2}-\\d{2}$(?![\\s\\S])')),
  generatedAt: z.iso.datetime({ offset: true }),
  sourceCount: z.number().int().min(0),
  sourceActivityCount: z
    .union([z.number().int().min(0), z.null()])
    .optional()
    .default(null),
  generationId: z.union([z.string(), z.null()]).optional().default(null),
  sourceHash: z.string().regex(new RegExp('^[a-f0-9]{64}$(?![\\s\\S])')),
  response: z.string().min(1),
});

export const DailyReviewViewSchema = z.strictObject({
  schemaVersion: z.literal(1).optional().default(1),
  day: z.string(),
  phase: z
    .enum([
      'scheduled',
      'running',
      'waiting_retry',
      'succeeded',
      'empty',
      'failed',
    ])
    .optional()
    .default('scheduled'),
  attemptId: z.union([z.string(), z.null()]).optional().default(null),
  trigger: z
    .union([z.enum(['automatic', 'manual']), z.null()])
    .optional()
    .default(null),
  startedAt: z
    .union([z.iso.datetime({ offset: true }), z.null()])
    .optional()
    .default(null),
  finishedAt: z
    .union([z.iso.datetime({ offset: true }), z.null()])
    .optional()
    .default(null),
  autoAttempts: z.number().int().min(0).optional().default(0),
  autoExhausted: z.boolean().optional().default(false),
  nextAttemptAt: z
    .union([z.iso.datetime({ offset: true }), z.null()])
    .optional()
    .default(null),
  lastError: z
    .union([DailyReviewDiagnosticSchema, z.null()])
    .optional()
    .default(null),
  presentedOn: z.union([z.string(), z.null()]).optional().default(null),
  homeId: z.string(),
  revision: z.string(),
  dueAt: z.iso.datetime({ offset: true }),
  maxAutoAttempts: z.number().int(),
  report: z.union([DailyReviewSchema, z.null()]).optional().default(null),
  canSummarize: z.boolean(),
  needsRecovery: z.boolean().optional().default(false),
  persistenceError: z
    .union([DailyReviewDiagnosticSchema, z.null()])
    .optional()
    .default(null),
});

export const DailyReviewConfigSchema = z.strictObject({
  maxChars: z.number().int().gt(0),
  scheduledTime: z
    .string()
    .regex(new RegExp('^(?:[01]\\d|2[0-3]):[0-5]\\d$(?![\\s\\S])')),
  maxAutoAttempts: z.number().int().gt(0),
  retryIntervalSeconds: z.number().gt(0),
  checkIntervalSeconds: z.number().gt(0),
});

export const DailyReviewCandidatesSchema = z.strictObject({
  homeId: z.string(),
  days: z.array(z.string()),
  nextCheckAt: z
    .union([z.iso.datetime({ offset: true }), z.null()])
    .optional()
    .default(null),
  policy: DailyReviewConfigSchema,
});

export const DailyReviewPresentedSchema = z.strictObject({
  day: z.string(),
  revision: z.string(),
  homeId: z.string(),
});

export const ObservationResultSchema = z.strictObject({
  visible_activity: z.string().min(1),
  inferred_intent: z.string().min(1),
  stage_and_evidence: z.string().min(1),
  app_tags: z.array(z.string().min(1)),
  task_types: z.array(z.string().min(1)).optional().default([]),
  schema_version: z.literal(1),
});

export const ActivityFrameSchema = z.strictObject({
  capturedAt: z.iso.datetime({ offset: true }),
  screenshot: z.string(),
  app: z.union([z.string(), z.null()]).optional().default(null),
  bundleId: z.union([z.string(), z.null()]).optional().default(null),
  screen: z
    .union([z.number().int().gt(0), z.null()])
    .optional()
    .default(null),
});

export const ActivityEventSchema = z.looseObject({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  app: z.union([z.string(), z.null()]).optional().default(null),
  bundleId: z.union([z.string(), z.null()]).optional().default(null),
  analysis: z.string().min(1),
  observation: z
    .union([ObservationResultSchema, z.null()])
    .optional()
    .default(null),
  source: z.literal('screen').optional().default('screen'),
  screenshot: z.string(),
  mini: z.string(),
  frames: z
    .union([z.array(ActivityFrameSchema).min(1), z.null()])
    .optional()
    .default(null),
});

export const SummaryActivitySchema = z.looseObject({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  app: z.union([z.string(), z.null()]).optional().default(null),
  analysis: z.string().min(1),
});

export const CoverageGapSchema = z.looseObject({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  reason: z.string(),
});

export const ActivitySummarySchema = z.looseObject({
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  generatedAt: z.iso.datetime({ offset: true }),
  timeline: z.array(SummaryActivitySchema),
  gaps: z.array(CoverageGapSchema),
  summary: z.string().min(1),
  trigger: z.enum(['periodic', 'manual_exit']).optional().default('periodic'),
});

export const TaskTimelineConfigSchema = z.strictObject({
  minOrganizeIntervalSeconds: z.number().gt(0),
  maxActivitiesPerBatch: z.number().int().gt(0),
  maxInputChars: z.number().int().gt(0),
  retryIntervalSeconds: z.number().gt(0),
  maxAttemptsPerRevision: z.number().int().gt(0),
  maxContinuityGapSeconds: z.number().gt(0),
});

export const PrivacyConfigSchema = z.strictObject({
  enabled: z.boolean(),
  sensitiveApps: z
    .array(z.string().min(1))
    .refine((items) => new Set(items).size === items.length, '列表项应唯一'),
  appKeywords: z
    .array(z.string().min(1))
    .refine((items) => new Set(items).size === items.length, '列表项应唯一'),
  ocrEnabled: z.boolean(),
  longTokenMin: z.number().int().min(6),
  splitTokenMin: z.number().int().min(6),
  splitJoinedMin: z.number().int().min(12),
  cardCheck: z.boolean(),
  idCheck: z.boolean(),
  labelCheck: z.boolean(),
});

export const DesktopConfigSchema = z.strictObject({
  refreshIntervalSeconds: z.number().gt(0),
});

export const ControlConfigSchema = z.strictObject({
  timeoutSeconds: z.number().gt(0),
  cancelGraceSeconds: z.number().gt(0),
  pollSeconds: z.number().gt(0),
});

export const SceningConfigSchema = z.strictObject({
  captureFps: z.number().gt(0),
  highResolutionFps: z.number().gt(0),
  highResolutionWidth: z.number().int().gt(0),
  highResolutionHeight: z.number().int().gt(0),
  monitorRefreshSeconds: z.number().gt(0),
  clickDebounceSeconds: z.number().gt(0),
  keyboardIdleSeconds: z.number().gt(0),
  scrollDebounceSeconds: z.number().gt(0),
  scrollMinPointerDistance: z.number().min(0),
  scrollMaxEventsPerSecond: z.number().gt(0),
  scrollResetSeconds: z.number().gt(0),
  scrollAfterSeconds: z.number().min(0),
  missingImageDifference: z.number().gt(0),
  actionIntervalSeconds: z.number().gt(0),
  minRawEvents: z.number().int().gt(0),
  segmentDifferenceThreshold: z.number().gt(0),
  stableComparisonCount: z.number().int().gt(0),
  observationIntervalSeconds: z.number().gt(0),
  sensingIdleSeconds: z.number().gt(0),
  recentActivityMultiplier: z.number().gt(0),
  recentActivityPaddingSeconds: z.number().min(0),
  jpegQuality: z.number().int().min(1).max(95),
  candidateQueueSize: z.number().int().gt(0),
  maxStoredActions: z.number().int().gt(1),
  shutdownTimeoutSeconds: z.number().gt(0),
});

export const AnalysisConfigSchema = z.strictObject({
  batchSize: z.number().int().min(2).max(3),
  frameMaxWidth: z.number().int().gt(0),
  frameMaxHeight: z.number().int().gt(0),
  labelHeight: z.number().int().gt(0),
  labelFontSize: z.number().int().gt(0),
  jpegQuality: z.number().int().min(1).max(95),
  maxImagePixels: z.number().int().gt(0),
  retryIntervalSeconds: z.number().gt(0),
  maxRetries: z.number().int().min(0),
});

export const ObserverConfigSchema = z.strictObject({
  _comments: z.record(z.string(), z.string()).optional(),
  home: z.string(),
  taskTimeline: z
    .union([TaskTimelineConfigSchema, z.null()])
    .optional()
    .default(null),
  privacy: z.union([PrivacyConfigSchema, z.null()]).optional().default(null),
  desktop: z.union([DesktopConfigSchema, z.null()]).optional().default(null),
  taskTypes: z
    .array(
      z
        .string()
        .min(1)
        .regex(new RegExp('^\\S(?:[^\\r\\n]*\\S)?$(?![\\s\\S])')),
    )
    .min(1)
    .refine((items) => new Set(items).size === items.length, '列表项应唯一'),
  screenshotDir: z.string(),
  sampleIntervalSeconds: z.number().gt(0),
  summaryIntervalSeconds: z.number().gt(0),
  captureCount: z.number().int().min(0),
  differenceThreshold: z.number().max(1).gt(0),
  captureTimeoutSeconds: z.number().gt(0),
  modelTimeoutSeconds: z.number().gt(0),
  terminationGraceSeconds: z.number().gt(0),
  control: ControlConfigSchema,
  analysisMaxChars: z.number().int().gt(0),
  summaryMaxChars: z.number().int().gt(0),
  dailyReview: DailyReviewConfigSchema,
  kmhLauncher: z.string(),
  kmhProfile: z.string().regex(new RegExp('^[A-Za-z0-9_-]+$(?![\\s\\S])')),
  scening: SceningConfigSchema,
  analysis: AnalysisConfigSchema,
});

export const ControlRequestSchema = z.strictObject({
  requestId: z.string().min(1),
  pid: z.number().int().gt(0),
  action: z.enum([
    'status',
    'analysis-status',
    'enable-analysis',
    'disable-analysis',
    'stop',
  ]),
});

export const AnalysisIssueSchema = z.strictObject({
  state: z.enum(['retrying', 'paused']),
  reason: z.string(),
});

export const ControlReplySchema = z.strictObject({
  requestId: z.string(),
  pid: z.number().int().gt(0),
  state: z.enum(['running', 'stopping', 'stopped']),
  analysisEnabled: z.boolean(),
  epoch: z.number().int().min(0),
  ok: z.boolean(),
  message: z.string(),
  analysisIssue: z
    .union([AnalysisIssueSchema, z.null()])
    .optional()
    .default(null),
});

export const DailyReviewReadySchema = z.strictObject({
  status: z.literal('ready').optional().default('ready'),
  review: DailyReviewSchema,
});

export const DailyReviewEmptySchema = z.strictObject({
  status: z.literal('empty').optional().default('empty'),
  message: z.string(),
});

export const DailyReviewErrorSchema = z.strictObject({
  status: z.literal('error').optional().default('error'),
  message: z.string(),
});

export const DailyReviewReplySchema = z.union([
  DailyReviewReadySchema,
  DailyReviewEmptySchema,
  DailyReviewErrorSchema,
]);

export const TaskSchema = z.strictObject({
  taskId: z.string().min(1),
  day: z.string(),
  title: z.string().min(1),
  object: z.string().min(1),
  goal: z.string().min(1),
});

export const EvidenceSchema = z.strictObject({
  activityId: z.string(),
  sourceSignature: z.string(),
  excerpt: z.string().min(1),
  frameIndexes: z.array(z.number().int().min(1)).optional(),
});

export const TaskLinkSchema = z.strictObject({
  taskId: z.string().min(1),
  action: z.string().optional().default(''),
  evidence: z.array(EvidenceSchema).optional().default([]),
  legacy: z.boolean().optional().default(false),
});

export const AssignmentSchema = z.strictObject({
  activityId: z.string(),
  sourceSignature: z.string(),
  taskLinks: z.array(TaskLinkSchema).optional().default([]),
  relationVersion: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .default(2),
  unassignedEvidence: z.array(EvidenceSchema).optional().default([]),
});

export const ProgressSchema = z.strictObject({
  progressId: z.string(),
  taskId: z.string(),
  text: z.string().min(1),
  kind: z.enum(['observed', 'ai_reported', 'inferred', 'unknown']),
  completionScope: z.union([z.string(), z.null()]).optional().default(null),
  evidence: z.array(EvidenceSchema).min(1),
});

export const DayTasksSchema = z.strictObject({
  schemaVersion: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .default(2),
  day: z.string(),
  generatedAt: z.string(),
  coveredUntil: z.union([z.string(), z.null()]),
  semanticRevision: z.string(),
  tasks: z.array(TaskSchema),
  assignments: z.array(AssignmentSchema),
  progress: z.array(ProgressSchema),
});

export const ProposedTaskSchema = z.strictObject({
  key: z.string().min(1),
  title: z.string().min(1).max(10),
  object: z.string().min(1),
  goal: z.string().min(1),
});

export const ProposedAssignmentSchema = z.strictObject({
  activityId: z.string(),
  taskKey: z.union([z.string(), z.null()]),
});

export const ProposedProgressSchema = z.strictObject({
  taskKey: z.string(),
  text: z.string().min(1),
  kind: z.enum(['observed', 'ai_reported', 'inferred', 'unknown']),
  evidence: z.array(EvidenceSchema).min(1),
  progressId: z.union([z.string(), z.null()]).optional().default(null),
});

export const TaskProposalSchema = z.strictObject({
  tasks: z.array(ProposedTaskSchema),
  assignments: z.array(ProposedAssignmentSchema),
  progress: z.array(ProposedProgressSchema),
});

export const ProposedBranchProgressSchema = z.strictObject({
  text: z.string().min(1),
  kind: z.enum(['observed', 'ai_reported', 'inferred', 'unknown']),
  evidenceIds: z.array(z.string()).min(1),
});

export const ProposedTaskLinkSchema = z.strictObject({
  taskKey: z.string().min(1),
  action: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
  progress: z.array(ProposedBranchProgressSchema).optional().default([]),
});

export const ProposedMultiAssignmentSchema = z.strictObject({
  activityId: z.string(),
  taskLinks: z.array(ProposedTaskLinkSchema),
  unassignedEvidenceIds: z.array(z.string()).optional().default([]),
});

export const MultiTaskProposalSchema = z.strictObject({
  schemaVersion: z.literal(2),
  newTasks: z.array(ProposedTaskSchema),
  assignments: z.array(ProposedMultiAssignmentSchema),
});

export const SegmentSchema = z.strictObject({
  segmentId: z.string(),
  taskId: z.union([z.string(), z.null()]),
  activityIds: z.array(z.string()),
  start: z.string(),
  end: z.string(),
  action: z.string(),
  estimateSeconds: z.number(),
  partial: z.boolean(),
  sliceIds: z.array(z.string()),
  pointIds: z.array(z.string()),
});

export const TimeSliceSchema = z.strictObject({
  sliceId: z.string(),
  start: z.string(),
  end: z.string(),
  kind: z.enum(['task', 'gap', 'uncertain']),
  taskId: z.union([z.string(), z.null()]),
  activityIds: z.array(z.string()),
  segmentId: z.union([z.string(), z.null()]),
  reason: z.union([z.string(), z.null()]),
});

export const TimePointSchema = z.strictObject({
  pointId: z.string(),
  at: z.string(),
  activityId: z.string(),
  taskId: z.union([z.string(), z.null()]),
  segmentId: z.string(),
});

export const TotalSchema = z.strictObject({
  taskId: z.string(),
  estimatedSeconds: z.number(),
  spanSeconds: z.number(),
  hasUncertainCoverage: z.boolean(),
});

export const DayTaskViewSchema = z.strictObject({
  day: z.string(),
  tasks: z.array(TaskSchema),
  segments: z.array(SegmentSchema),
  progress: z.array(ProgressSchema),
  slices: z.array(TimeSliceSchema),
  points: z.array(TimePointSchema),
  totals: z.array(TotalSchema),
  issues: z.array(z.string()),
  start: z.union([z.string(), z.null()]),
  end: z.union([z.string(), z.null()]),
  coveredUntil: z.union([z.string(), z.null()]),
});

export const SampleSchema = z.strictObject({
  sampleId: z.string(),
  activityId: z.string(),
  sourceSignature: z.string(),
  capturedAt: z.string(),
  runId: z.string(),
  continuityId: z.string(),
  sampleSequence: z.number().int().min(0),
  app: z.union([z.string(), z.null()]),
  bundleId: z.union([z.string(), z.null()]),
  screen: z.union([z.number().int(), z.null()]),
});

export const BreakSchema = z.strictObject({
  kind: z.enum(['point', 'range']),
  at: z.union([z.string(), z.null()]).optional().default(null),
  start: z.union([z.string(), z.null()]).optional().default(null),
  end: z.union([z.string(), z.null()]).optional().default(null),
  runId: z.string(),
  reason: z.string(),
});

export const TimeEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1).optional().default(1),
  day: z.string(),
  samples: z.array(SampleSchema),
  breaks: z.array(BreakSchema),
});

export const TimelineReadReplySchema = z.strictObject({
  day: z.string(),
  sourceRevision: z.string(),
  semanticRevision: z.string().optional().default(''),
  needsOrganization: z.boolean().optional().default(false),
  pendingCount: z.number().int().optional().default(0),
  evidenceRevision: z.string(),
  taskRevision: z.string(),
  organizing: z.enum(['idle', 'running', 'failed', 'disabled']),
  coveredUntil: z.union([z.string(), z.null()]),
  view: z.union([DayTaskViewSchema, z.null()]),
  issues: z.array(z.string()),
});

export const BackfillStatusSchema = z.strictObject({
  day: z.string(),
  state: z.enum([
    'idle',
    'running',
    'completed',
    'partial',
    'cancelled',
    'failed',
    'empty',
    'error',
  ]),
  total: z.union([z.number().int().min(0), z.null()]),
  analyzed: z.union([z.number().int().min(0), z.null()]),
  remaining: z.union([z.number().int().min(0), z.null()]),
  eligible: z.boolean(),
  planned: z.number().int().min(0).optional().default(0),
  processed: z.number().int().min(0).optional().default(0),
  message: z.string().optional().default(''),
  activeDay: z.union([z.string(), z.null()]).optional().default(null),
  owned: z.boolean().optional().default(false),
});
