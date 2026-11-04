import { app, BrowserWindow, ipcMain, Menu, powerMonitor } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdirSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoSnapshot } from '../shared/demo';
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
  SaveSettingsSchema,
  SettingsSnapshotSchema,
  BackfillQuerySchema,
  BackfillActionSchema,
  BackgroundsReplySchema,
} from '../shared/protocol';
import type { Snapshot } from '../shared/protocol';
import { readLocalDay, readSnapshotImage } from './data';
import { CaptureController } from './capture';
import { TaskTimelineService } from './task-timeline';
import { ArchiveImageExporter } from './archive-image';
import { DailyReviewService } from './daily-review';
import { DailyReviewScheduler } from './daily-review-scheduler';
import { PresetService } from './presets';
import { SettingsService } from './settings';
import { BackfillService } from './backfill';
import {
  DailyReviewReplySchema,
  DailyReviewViewSchema,
} from '../shared/scening.generated';
import { readLocalBuild } from '../version-check/check';
import { createLocalClientRestart } from '../version-check/restart';
import { scheduleMacRestart } from '../version-check/mac-restart';
import { localClientPaths } from '../version-check/paths';
import { RuntimeModeSchema } from '../runtime-mode';
import { prepareRuntimePaths } from './runtime-paths';
import {
  LOCAL_BUILD_CHECK_INTERVAL_MS,
  LocalBuildInfoSchema,
  LocalBuildStatusSchema,
} from '../version-check/protocol';

const archiveImages = new ArchiveImageExporter();
app.setName('x-scening');
const directory = path.dirname(fileURLToPath(import.meta.url));
declare const __OBSERVER_PROJECT_ROOT__: string;
declare const __OBSERVER_LOCAL_BUILD__: unknown;
declare const __OBSERVER_RUNTIME_MODE__: unknown;
declare const __OBSERVER_BASE_CONFIG__: string;
declare const __OBSERVER_PUBLISH_CONFIG__: string;
const runningBuild = LocalBuildInfoSchema.parse(__OBSERVER_LOCAL_BUILD__);
let localBuildTimer: ReturnType<typeof setInterval> | undefined;
const projectRoot =
  process.env.OBSERVER_PROJECT_ROOT ?? __OBSERVER_PROJECT_ROOT__;
const runtimePaths = await prepareRuntimePaths(
  projectRoot,
  RuntimeModeSchema.parse(__OBSERVER_RUNTIME_MODE__),
  process.env.OBSERVER_CONFIG,
  { base: __OBSERVER_BASE_CONFIG__, publish: __OBSERVER_PUBLISH_CONFIG__ },
);
const configPath = runtimePaths.configPath;
const cacheRoot = runtimePaths.cacheRoot;
process.env.SCENING_LOG_DIR = runtimePaths.logRoot;
const capture = new CaptureController(projectRoot, configPath, cacheRoot);
const presets = new PresetService(projectRoot, configPath);
const settings = new SettingsService(projectRoot, configPath);
const taskTimeline = new TaskTimelineService(
  projectRoot,
  configPath,
  __OBSERVER_PROJECT_ROOT__,
);
const dailyReview = new DailyReviewService(projectRoot, configPath);
const backfill = new BackfillService(
  projectRoot,
  configPath,
  __OBSERVER_PROJECT_ROOT__,
);
mkdirSync(cacheRoot, { recursive: true });
app.setPath('userData', path.join(cacheRoot, 'user-data'));
app.setPath('sessionData', path.join(cacheRoot, 'session-data'));
app.setPath('logs', path.join(cacheRoot, 'logs'));
app.setPath('crashDumps', path.join(cacheRoot, 'crashes'));
app.commandLine.appendSwitch('disable-http-cache');

let window: BrowserWindow | null = null;
let screenLocked = false;
const canPresentDailyReview = (): boolean =>
  !screenLocked && window !== null && window.isVisible() && window.isFocused();
/** 展示日志仅保存日期、版本与窗口状态，供核对请求、延后和实际确认。 */
function logDailyPresentation(result: string, day: string): void {
  const folder = runtimePaths.logRoot;
  const entry = {
    time: new Date().toISOString(),
    stage: 'daily_review_presentation',
    result,
    day,
    buildId: runningBuild.buildId,
    visible: window?.isVisible() ?? false,
    focused: window?.isFocused() ?? false,
    screenLocked,
  };
  mkdir(folder, { recursive: true })
    .then(() =>
      appendFile(
        path.join(folder, 'x-scening.log'),
        JSON.stringify(entry) + '\n',
      ),
    )
    .catch(console.error);
}
const dailyScheduler = new DailyReviewScheduler(
  dailyReview,
  {
    changed: (view) => {
      window?.webContents.send(
        'observer:daily-review-changed',
        DailyReviewViewSchema.parse(view),
      );
    },
    open: (view) => {
      logDailyPresentation('requested', view.day);
      window?.webContents.send(
        'observer:daily-review-open',
        DailyReviewViewSchema.parse(view),
      );
    },
    problem: (error) => {
      console.error('每日总结后台失败', error);
    },
  },
  canPresentDailyReview,
);

let shutdownTask: Promise<void> | null = null;
/** 普通退出与更新共用收尾，全部作业完成后才允许结束当前进程。 */
function shutdownClient(): Promise<void> {
  if (shutdownTask) return shutdownTask;
  dailyScheduler.stop();
  taskTimeline.suspend();
  shutdownTask = Promise.allSettled([
    capture.shutdown(),
    taskTimeline.shutdown(),
    backfill.shutdown(),
    dailyReview.shutdown(),
  ])
    .then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected'
          ? [
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          ]
          : [],
      );
      if (failures.length) throw new Error(failures.join('\n'));
    })
    .finally(() => {
      shutdownTask = null;
    });
  return shutdownTask;
}
const restartLocalClient = createLocalClientRestart(projectRoot, runningBuild, {
  shutdown: shutdownClient,
  relaunch: (options) =>
    process.platform === 'darwin'
      ? scheduleMacRestart(
        localClientPaths(projectRoot).app,
        projectRoot,
        options.args,
        configPath,
      )
      : app.relaunch(options),
  quit: () => app.quit(),
});

capture.subscribe((runtime) => {
  taskTimeline.runtime(runtime);
  window?.webContents.send(
    'observer:runtime-changed',
    RuntimeSnapshotSchema.parse(runtime),
  );
});
let latest: Snapshot | null = null;
let readGeneration = 0;
function checkSender(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('仅客户端主页面可读取记录');
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 780,
    minHeight: 600,
    title: 'x-scening',
    backgroundColor: '#f7f1e3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(directory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.on('ready-to-show', () => {
    window?.show();
  });
  window.on('focus', () => {
    dailyScheduler.foreground().catch(console.error);
  });
  window.on('blur', () => dailyScheduler.resetPresentation());
  window.on('hide', () => dailyScheduler.resetPresentation());
  window.webContents.on('did-finish-load', () => {
    dailyScheduler.resetPresentation();
    dailyScheduler.foreground().catch(console.error);
  });
  window.on('closed', () => {
    dailyScheduler.resetPresentation();
    window = null;
    latest = null;
    readGeneration++;
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  const loaded = url
    ? window.loadURL(url)
    : window.loadFile(path.join(directory, '../renderer/index.html'));
  loaded.catch((error: unknown) => {
    console.error('客户端页面加载失败', error);
  });
}

app
  .whenReady()
  .then(() => {
    ipcMain.handle('observer:restart-local-client', async (event) => {
      checkSender(event);
      await restartLocalClient();
    });
    ipcMain.handle('observer:local-build', async (event) => {
      checkSender(event);
      return LocalBuildStatusSchema.parse(
        await readLocalBuild(projectRoot, runningBuild),
      );
    });
    localBuildTimer = setInterval(() => {
      readLocalBuild(projectRoot, runningBuild)
        .then((status) => {
          window?.webContents.send(
            'observer:local-build-changed',
            LocalBuildStatusSchema.parse(status),
          );
        })
        .catch((error: unknown) => {
          console.error('本机构建检查失败', error);
        });
    }, LOCAL_BUILD_CHECK_INTERVAL_MS);
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Observer',
          submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
    ipcMain.handle('observer:day', async (event, raw: unknown) => {
      checkSender(event);
      const query = QuerySchema.parse(raw);
      const generation = ++readGeneration;
      if (latest?.day !== query.day || latest.source !== query.source)
        latest = null;
      const snapshot =
        query.source === 'demo'
          ? demoSnapshot(query.day)
          : await readLocalDay(projectRoot, query.day, configPath);
      if (generation === readGeneration) latest = snapshot;
      return SnapshotSchema.parse(snapshot);
    });
    ipcMain.handle('observer:task-timeline', async (event, raw: unknown) => {
      checkSender(event);
      return taskTimeline.read(TaskTimelineQuerySchema.parse(raw));
    });
    ipcMain.handle('observer:backfill', async (event, raw: unknown) => {
      checkSender(event);
      return backfill.read(BackfillQuerySchema.parse(raw));
    });
    ipcMain.handle('observer:backfill-control', async (event, raw: unknown) => {
      checkSender(event);
      return backfill.control(BackfillActionSchema.parse(raw));
    });
    ipcMain.handle('observer:backgrounds', (event) => {
      checkSender(event);
      return BackgroundsReplySchema.parse({
        organizing: taskTimeline.background(),
        backfill: backfill.background(),
      });
    });
    ipcMain.handle('observer:settings', async (event) => {
      checkSender(event);
      return SettingsSnapshotSchema.parse(await settings.read());
    });
    ipcMain.handle('observer:save-settings', async (event, raw: unknown) => {
      checkSender(event);
      const request = SaveSettingsSchema.parse(raw);
      // 保存前识别当前采集，保留独立进程的控制位置与启动快照。
      await capture.read();
      const saved = await settings.save(request);
      dailyReview.settingsChanged();
      dailyScheduler.policyChanged();
      return SettingsSnapshotSchema.parse(saved);
    });
    ipcMain.handle('observer:presets', async (event) => {
      checkSender(event);
      return PresetSnapshotSchema.parse(await presets.read());
    });
    ipcMain.handle('observer:save-presets', async (event, raw: unknown) => {
      checkSender(event);
      return PresetSnapshotSchema.parse(
        await presets.save(TaskTypePresetsSchema.parse(raw)),
      );
    });
    ipcMain.handle(
      'observer:save-archive-image',
      async (event, raw: unknown) => {
        checkSender(event);
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) throw new Error('档案窗口已关闭');
        return ArchiveImageReplySchema.parse(
          await archiveImages.save(owner, DailyArchiveSchema.parse(raw)),
        );
      },
    );
    ipcMain.handle(
      'observer:daily-review-state',
      async (event, raw: unknown) => {
        checkSender(event);
        return dailyReview.inspect(DailyReviewDayQuerySchema.parse(raw).day);
      },
    );
    ipcMain.handle(
      'observer:daily-review-generate',
      async (event, raw: unknown) => {
        checkSender(event);
        const query = DailyReviewGenerateQuerySchema.parse(raw);
        const view = await dailyReview.generate(
          query.day,
          'manual',
          query.homeId,
        );
        window?.webContents.send('observer:daily-review-changed', view);
        return view;
      },
    );
    ipcMain.handle(
      'observer:daily-review-presented',
      async (event, raw: unknown) => {
        checkSender(event);
        const query = DailyReviewPresentedQuerySchema.parse(raw);
        if (!canPresentDailyReview()) {
          logDailyPresentation('deferred', query.day);
          return dailyReview.inspect(query.day);
        }
        const view = await dailyReview.presented(
          query.day,
          query.revision,
          query.homeId,
        );
        logDailyPresentation(
          view.presentedOn ? 'confirmed' : 'deferred',
          query.day,
        );
        return view;
      },
    );
    ipcMain.handle('observer:daily-review', async (event, raw: unknown) => {
      checkSender(event);
      const query = DailyReviewQuerySchema.parse(raw);
      const reply = DailyReviewReplySchema.parse(await dailyReview.read(query));
      if (query.source === 'local' && query.refresh && reply.status === 'ready')
        window?.webContents.send(
          'observer:daily-review-changed',
          await dailyReview.inspect(query.day),
        );
      return reply;
    });
    ipcMain.handle('observer:image', async (event, raw: unknown) => {
      checkSender(event);
      const query = ImageQuerySchema.parse(raw);
      return ImageResultSchema.parse(
        latest
          ? await readSnapshotImage(latest, query.id, query.frameIndex)
          : { status: 'missing', message: '请先读取活动记录。' },
      );
    });
    ipcMain.handle('observer:runtime', async (event) => {
      checkSender(event);
      const state = await capture.read();
      taskTimeline.runtime(state);
      return RuntimeSnapshotSchema.parse(state);
    });
    ipcMain.handle('observer:capture', async (event, raw: unknown) => {
      checkSender(event);
      const action = CaptureActionSchema.parse(raw);
      if (action === 'stop' || action === 'disable-analysis')
        taskTimeline.suspend();
      if (action === 'start' || action === 'enable-analysis')
        taskTimeline.permit();
      switch (action) {
        case 'start':
          return RuntimeSnapshotSchema.parse(await capture.start());
        case 'stop':
          return RuntimeSnapshotSchema.parse(await capture.stop());
        case 'enable-analysis':
          return RuntimeSnapshotSchema.parse(
            await capture.setAnalysisEnabled(true),
          );
        case 'disable-analysis':
          return RuntimeSnapshotSchema.parse(
            await capture.setAnalysisEnabled(false),
          );
      }
    });
    screenLocked = powerMonitor.getSystemIdleState(1) === 'locked';
    createWindow();
    dailyScheduler.start();
    powerMonitor.on('lock-screen', () => {
      screenLocked = true;
      dailyScheduler.resetPresentation();
    });
    powerMonitor.on('unlock-screen', () => {
      screenLocked = false;
      dailyScheduler.foreground().catch(console.error);
    });
    powerMonitor.on('resume', () => {
      dailyScheduler.policyChanged();
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('客户端启动失败', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  clearInterval(localBuildTimer);
});
let quitting = false;
app.on('before-quit', (event) => {
  dailyScheduler.stop();
  taskTimeline.suspend();
  if (
    !capture.ownsProcess &&
    !taskTimeline.hasWork &&
    !backfill.hasWork &&
    !dailyReview.hasWork
  )
    return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  shutdownClient()
    .then(() => app.quit())
    .catch((error: unknown) => {
      quitting = false;
      console.error('等待采集退出失败', error);
    });
});
