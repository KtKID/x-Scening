import { contextBridge, ipcRenderer } from 'electron';
import { LocalBuildStatusSchema } from '../version-check/protocol';
import {
  ImageQuerySchema,
  DailyReviewDayQuerySchema,
  DailyReviewGenerateQuerySchema,
  DailyReviewPresentedQuerySchema,
  ImageResultSchema,
  QuerySchema,
  TaskTimelineQuerySchema,
  DailyReviewQuerySchema,
  DailyArchiveSchema,
  ArchiveImageReplySchema,
  SnapshotSchema,
  CaptureActionSchema,
  RuntimeSnapshotSchema,
  PresetSnapshotSchema,
  TaskTypePresetsSchema,
  SettingsSnapshotSchema,
  SaveSettingsSchema,
  BackfillQuerySchema,
  BackfillActionSchema,
  BackgroundsReplySchema,
} from '../shared/protocol';
import {
  DailyReviewReplySchema,
  DailyReviewViewSchema,
  TimelineReadReplySchema,
  BackfillStatusSchema,
} from '../shared/scening.generated';
import type { ObserverBridge } from '../shared/protocol';
import {
  ModelSettingsSchema,
  ModelSelectionSchema,
  SaveProviderSchema,
  ProviderIdSchema,
} from '../shared/models';

const bridge: ObserverBridge = {
  readModelSettings: async () =>
    ModelSettingsSchema.parse(await ipcRenderer.invoke('observer:models')),
  saveModelProvider: async (request) =>
    ModelSettingsSchema.parse(
      await ipcRenderer.invoke(
        'observer:models-save',
        SaveProviderSchema.parse(request),
      ),
    ),
  selectModel: async (request) =>
    ModelSettingsSchema.parse(
      await ipcRenderer.invoke(
        'observer:models-select',
        ModelSelectionSchema.parse(request),
      ),
    ),
  removeModelProvider: async (provider) =>
    ModelSettingsSchema.parse(
      await ipcRenderer.invoke(
        'observer:models-remove',
        ProviderIdSchema.parse(provider),
      ),
    ),
  readDailyReviewState: async (query) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:daily-review-state',
      DailyReviewDayQuerySchema.parse(query),
    );
    return DailyReviewViewSchema.parse(raw);
  },
  generateDailyReview: async (query) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:daily-review-generate',
      DailyReviewGenerateQuerySchema.parse(query),
    );
    return DailyReviewViewSchema.parse(raw);
  },
  markDailyReviewPresented: async (query) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:daily-review-presented',
      DailyReviewPresentedQuerySchema.parse(query),
    );
    return DailyReviewViewSchema.parse(raw);
  },
  onDailyReviewOpen: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      listener(DailyReviewViewSchema.parse(raw));
    };
    ipcRenderer.on('observer:daily-review-open', receive);
    return () => {
      ipcRenderer.removeListener('observer:daily-review-open', receive);
    };
  },
  onDailyReviewChanged: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      listener(DailyReviewViewSchema.parse(raw));
    };
    ipcRenderer.on('observer:daily-review-changed', receive);
    return () => {
      ipcRenderer.removeListener('observer:daily-review-changed', receive);
    };
  },

  restartLocalClient: async () => {
    await ipcRenderer.invoke('observer:restart-local-client');
  },
  readLocalBuild: async () => {
    const raw: unknown = await ipcRenderer.invoke('observer:local-build');
    return LocalBuildStatusSchema.parse(raw);
  },
  onLocalBuild: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      listener(LocalBuildStatusSchema.parse(raw));
    };
    ipcRenderer.on('observer:local-build-changed', receive);
    return () => {
      ipcRenderer.removeListener('observer:local-build-changed', receive);
    };
  },
  saveArchiveImage: async (archive) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:save-archive-image',
      DailyArchiveSchema.parse(archive),
    );
    return ArchiveImageReplySchema.parse(raw);
  },
  readBackfill: async (query) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:backfill',
      BackfillQuerySchema.parse(query),
    );
    return BackfillStatusSchema.parse(raw);
  },
  controlBackfill: async (request) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:backfill-control',
      BackfillActionSchema.parse(request),
    );
    return BackfillStatusSchema.parse(raw);
  },
  readBackgrounds: async () => {
    const raw: unknown = await ipcRenderer.invoke('observer:backgrounds');
    return BackgroundsReplySchema.parse(raw);
  },
  readSettings: async () => {
    const raw: unknown = await ipcRenderer.invoke('observer:settings');
    return SettingsSnapshotSchema.parse(raw);
  },
  saveSettings: async (settings) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:save-settings',
      SaveSettingsSchema.parse(settings),
    );
    return SettingsSnapshotSchema.parse(raw);
  },
  readPresets: async () => {
    const raw: unknown = await ipcRenderer.invoke('observer:presets');
    return PresetSnapshotSchema.parse(raw);
  },
  savePresets: async (presets) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:save-presets',
      TaskTypePresetsSchema.parse(presets),
    );
    return PresetSnapshotSchema.parse(raw);
  },
  readDailyReview: async (query) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:daily-review',
      DailyReviewQuerySchema.parse(query),
    );
    return DailyReviewReplySchema.parse(raw);
  },
  onRuntime: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      listener(RuntimeSnapshotSchema.parse(raw));
    };
    ipcRenderer.on('observer:runtime-changed', receive);
    return () => {
      ipcRenderer.removeListener('observer:runtime-changed', receive);
    };
  },
  readRuntime: async () => {
    const raw: unknown = await ipcRenderer.invoke('observer:runtime');
    return RuntimeSnapshotSchema.parse(raw);
  },
  controlCapture: async (action) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:capture',
      CaptureActionSchema.parse(action),
    );
    return RuntimeSnapshotSchema.parse(raw);
  },
  readTaskTimeline: async (query) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:task-timeline',
      TaskTimelineQuerySchema.parse(query),
    );
    return TimelineReadReplySchema.parse(raw);
  },
  readDay: async (query) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:day',
      QuerySchema.parse(query),
    );
    return SnapshotSchema.parse(raw);
  },
  readImage: async (id, frameIndex) => {
    const raw: unknown = await ipcRenderer.invoke(
      'observer:image',
      ImageQuerySchema.parse({ id, frameIndex }),
    );
    return ImageResultSchema.parse(raw);
  },
};
contextBridge.exposeInMainWorld('observer', bridge);
