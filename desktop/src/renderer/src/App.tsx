import { DailyReviewReplySchema } from '../../shared/scening.generated';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  CodeXml,
  FileText,
  Globe,
  ImageIcon,
  Images,
  ListTodo,
  RefreshCw,
  Play,
  Square,
  Settings2,
  Terminal,
  X,
} from 'lucide-react';
import { clock, localDay, minutes, moveDay } from '../../shared/protocol';
import type {
  ImageResult,
  ObserverBridge,
  Snapshot,
  Source,
  TimelineActivity,
  CaptureState,
  CaptureAction,
  BackgroundsReply,
  DailyReviewReply,
  DailyReviewView,
  DailyArchive,
  ArchiveImageReply,
} from '../../shared/protocol';
import { TaskTimeline } from './TaskTimeline';
import { TaskDetails } from './TaskDetails';
import type { z } from 'zod';
import type { TimelineReadReplySchema } from '../../shared/scening.generated';
import { DailyReviewModal } from './DailyReviewModal';
import { DailyArchiveSheet } from './DailyArchiveSheet';
import { buildDailyArchive } from '../../shared/daily-archive';
import { TaskTypeLabels } from './TaskTypeLabels';
import { useDailyReviewDialog } from './useDailyReviewDialog';
import { SettingsEditor } from './SettingsEditor';
import { LocalBuildNotice } from '../../version-check/LocalBuildNotice';
import { BackfillPage } from './BackfillPage';
import { demoSnapshot, demoDailyReview, TEST_PREFIX } from '../../shared/demo';
import {
  activityTime,
  cardPreview,
  capturedApplicationNames,
  capturedApplicationLabel as appName,
  applicationCounts,
} from '../../shared/presentation';

const brandLogoUrl = new URL('./assets/secening-logo.svg', import.meta.url)
  .href;

declare global {
  interface Window {
    observer?: ObserverBridge;
  }
}

const browserBridge: ObserverBridge = {
  readModelSettings: () =>
    Promise.reject(new Error('请在桌面客户端配置模型。')),
  saveModelProvider: () =>
    Promise.reject(new Error('请在桌面客户端配置模型。')),
  selectModel: () => Promise.reject(new Error('请在桌面客户端配置模型。')),
  removeModelProvider: () =>
    Promise.reject(new Error('请在桌面客户端配置模型。')),
  readDailyReviewState: () =>
    Promise.reject(new Error('Daily summary requires desktop')),
  generateDailyReview: () =>
    Promise.reject(new Error('Daily summary requires desktop')),
  markDailyReviewPresented: () =>
    Promise.reject(new Error('Daily summary requires desktop')),
  onDailyReviewOpen: () => () => {},
  onDailyReviewChanged: () => () => {},

  restartLocalClient: () =>
    Promise.reject(new Error('重启更新由桌面客户端提供。')),
  readLocalBuild: () =>
    Promise.reject(new Error('本机构建状态由桌面客户端提供。')),
  onLocalBuild: () => () => {},
  saveArchiveImage: () =>
    Promise.resolve({
      status: 'error',
      message: '请在桌面客户端保存档案图片。',
    }),
  readBackfill: () => Promise.reject(new Error('请在桌面客户端补分析。')),
  controlBackfill: () => Promise.reject(new Error('请在桌面客户端补分析。')),
  screenshotDirectory: () =>
    Promise.reject(new Error('请在桌面客户端查看截图保存目录。')),
  readBackgrounds: () =>
    Promise.reject(new Error('请在桌面客户端查看后台状态。')),
  readTaskTimeline: (query) =>
    Promise.resolve({
      day: query.day,
      semanticRevision: '',
      needsOrganization: false,
      pendingCount: 0,
      sourceRevision: '',
      taskRevision: '',
      evidenceRevision: '',
      organizing: 'disabled',
      coveredUntil: null,
      view: null,
      issues: [],
    }),
  readSettings: () => Promise.reject(new Error('请在桌面客户端编辑运行配置。')),
  saveSettings: () => Promise.reject(new Error('请在桌面客户端保存运行配置。')),
  readPresets: () => Promise.reject(new Error('请在桌面客户端维护预设。')),
  savePresets: () => Promise.reject(new Error('请在桌面客户端保存预设。')),
  readDailyReview: (query) =>
    Promise.resolve(
      query.source === 'demo'
        ? DailyReviewReplySchema.parse(demoDailyReview(query.day))
        : { status: 'error', message: '请在桌面客户端生成每日总结。' },
    ),
  onRuntime: () => () => {},
  readRuntime: () => Promise.reject(new Error('请在桌面客户端控制采集。')),
  controlCapture: () => Promise.reject(new Error('请在桌面客户端控制采集。')),
  readDay: (query) =>
    Promise.resolve(
      query.source === 'demo'
        ? demoSnapshot(query.day)
        : emptySnapshot(query.day, ['请在桌面客户端查看本地记录。']),
    ),
  readImage: () =>
    Promise.resolve({ status: 'missing', message: '请在桌面客户端查看截图。' }),
};
const bridge = window.observer ?? browserBridge;
declare const __OBSERVER_VERSION__: string;
declare const __OBSERVER_SIDEBAR_VERSION__: string;

type Page = 'timeline' | 'summaries' | 'settings' | 'backfill';
type SummaryTab = 'periodic' | 'daily';
type DailyReview = Extract<DailyReviewReply, { status: 'ready' }>['review'];
/** 总结页每日tab的只读快照；生成中与失败提示由独立状态表达，旧正文保留。 */
type DailyTabState =
  | { status: 'loading' }
  | { status: 'ready'; review: DailyReview; source: Source }
  | { status: 'empty'; message: string }
  | { status: 'error'; message: string };
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: Snapshot }
  | { status: 'error'; message: string };

function dailyTabState(
  reply: DailyReviewReply,
  day: string,
  source: Source,
): DailyTabState {
  if (reply.status === 'ready')
    return reply.review.day === day
      ? { status: 'ready', review: reply.review, source }
      : { status: 'error', message: '每日总结日期无效' };
  if (reply.status === 'empty')
    return { status: 'empty', message: reply.message };
  return { status: 'error', message: reply.message };
}

function emptySnapshot(day: string, issues: string[] = []): Snapshot {
  return {
    day,
    source: 'local',
    sourceRevision: '',
    activities: [],
    summaries: [],
    issues,
    locations: { configPath: '', home: '', screenshotDir: '' },
  };
}
function accent(name: string): string {
  if (/code|编程/i.test(name)) return 'ochre';
  if (/chrome|safari|浏览/i.test(name)) return 'olive';
  return 'slate';
}
function AppIcon({ name, size = 18 }: { name: string; size?: number }) {
  if (/code|编程/i.test(name)) return <CodeXml size={size} />;
  if (/chrome|safari|浏览/i.test(name)) return <Globe size={size} />;
  return <Terminal size={size} />;
}
function appCounts(snapshot: Snapshot): [string, number][] {
  return applicationCounts(snapshot.activities);
}
function dateLabel(day: string): string {
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
}
function weekday(day: string): string {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(
    new Date(`${day}T12:00:00`),
  );
}

export function App() {
  const [day, setDay] = useState(localDay);
  const [source, setSource] = useState<Source>('local');
  const [page, setPage] = useState<Page>('timeline');
  const review = useDailyReviewDialog(bridge, source);
  const workspaceBody = useRef<HTMLDivElement>(null);
  const pageScroll = useRef<Record<Page, number>>({
    timeline: 0,
    summaries: 0,
    settings: 0,
    backfill: 0,
  });
  useLayoutEffect(() => {
    if (workspaceBody.current) {
      workspaceBody.current.scrollTop = pageScroll.current[page];
    }
  }, [page]);
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<number | undefined>();
  const showImage = (id: string, frameIndex?: number) => {
    setSelectedFrame(frameIndex);
    setSelectedId(id);
  };
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [taskReply, setTaskReply] = useState<z.infer<
    typeof TimelineReadReplySchema
  > | null>(null);
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [retainedTaskSegment, setRetainedTaskSegment] = useState<string | null>(
    null,
  );
  const [pendingSegment, setPendingSegment] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState('');
  const manualRefresh = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [summaryTab, setSummaryTab] = useState<SummaryTab>('periodic');
  const [dailyTab, setDailyTab] = useState<DailyTabState>({
    status: 'loading',
  });
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState<
    number | null
  >(null);
  const [dailyView, setDailyView] = useState<DailyReviewView | null>(null);
  const dailyGeneration = useRef(0);
  const applyDailyView = useCallback((value: DailyReviewView): void => {
    setDailyView(value);
    if (value.report)
      setDailyTab({ status: 'ready', review: value.report, source: 'local' });
    else if (value.phase === 'failed')
      setDailyTab({
        status: 'error',
        message:
          value.lastError?.details ??
          value.lastError?.message ??
          '每日总结失败',
      });
    else
      setDailyTab({
        status: 'empty',
        message: value.phase === 'empty' ? '当日无记录' : '等待生成每日总结',
      });
  }, []);
  useEffect(
    () =>
      bridge.onDailyReviewChanged((value) => {
        if (source === 'local' && value.day === day)
          setRefresh((previous) => previous + 1);
      }),
    [source, day],
  );
  useEffect(() => {
    // 所选日期的报告供概览与每日页共用；查询保持只读，切换后旧请求失效。
    const current = ++dailyGeneration.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDailyTab({ status: 'loading' });
    setDailyView(null);
    const update = async (): Promise<void> => {
      try {
        if (source === 'demo') {
          const reply = await bridge.readDailyReview({
            day,
            source,
            refresh: false,
            cachedOnly: true,
          });
          if (current === dailyGeneration.current)
            setDailyTab(dailyTabState(reply, day, source));
        } else {
          const value = await bridge.readDailyReviewState({ day });
          if (current === dailyGeneration.current && value.day === day)
            applyDailyView(value);
        }
      } catch (error: unknown) {
        if (current === dailyGeneration.current)
          setDailyTab({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      }
      if (
        current === dailyGeneration.current &&
        source === 'local' &&
        refreshIntervalSeconds !== null
      )
        timer = setTimeout(() => {
          update().catch(console.error);
        }, refreshIntervalSeconds * 1000);
    };
    update().catch(console.error);
    return () => {
      if (timer) clearTimeout(timer);
      dailyGeneration.current++;
    };
  }, [day, source, refresh, refreshIntervalSeconds, applyDailyView]);
  const [capture, setCapture] = useState<CaptureState>({
    state: 'stopped',
    message: '正在读取采集状态',
  });
  const [operation, setOperation] = useState<CaptureAction | null>(null);
  const [analysisEnabled, setAnalysisEnabled] = useState(true);
  const [backgrounds, setBackgrounds] = useState<BackgroundsReply | null>(null);
  const controlling = operation !== null;
  const changingAnalysis =
    operation === 'enable-analysis' || operation === 'disable-analysis';
  const [groupingGapSeconds, setGroupingGapSeconds] = useState<number | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    bridge
      .readSettings()
      .then((settings) => {
        if (active)
          setGroupingGapSeconds(
            settings.config.taskTimeline?.maxContinuityGapSeconds ?? null,
          );
      })
      .catch(() => {
        if (active) setGroupingGapSeconds(null);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  const controlGeneration = useRef(0);
  const runtimeRevision = useRef(0);
  const applyRuntime = useCallback(
    (runtime: Awaited<ReturnType<ObserverBridge['readRuntime']>>) => {
      if (runtime.revision < runtimeRevision.current) return;
      runtimeRevision.current = runtime.revision;
      setCapture(runtime.capture);
      setAnalysisEnabled(runtime.analysisEnabled);
      setRefreshIntervalSeconds(runtime.refreshIntervalSeconds);
    },
    [],
  );
  useEffect(() => bridge.onRuntime(applyRuntime), [applyRuntime]);
  useEffect(() => {
    const current = ++generation.current;
    setTaskReply((previous) =>
      source === 'local' && previous?.day === day ? previous : null,
    );
    setTaskNotice('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoad((previous) =>
      previous.status === 'ready' &&
      previous.snapshot.day === day &&
      previous.snapshot.source === source
        ? previous
        : { status: 'loading' },
    );
    const update = async (initial: boolean): Promise<void> => {
      if (initial) setReading(true);
      const [records, runtime, jobs] = await Promise.allSettled([
        initial || source === 'local'
          ? bridge.readDay({ day, source })
          : Promise.resolve(null),
        bridge.readRuntime(),
        bridge.readBackgrounds(),
      ]);
      if (current !== generation.current) return;
      if (jobs.status === 'fulfilled') setBackgrounds(jobs.value);
      if (records.status === 'rejected')
        setLoad({
          status: 'error',
          message:
            records.reason instanceof Error
              ? records.reason.message
              : '记录读取失败',
        });
      if (records.status === 'fulfilled' && records.value) {
        const reply = await bridge
          .readTaskTimeline({
            day,
            source,
            expectedSourceRevision: records.value.sourceRevision,
            refreshReason: manualRefresh.current ? 'manual' : 'auto',
          })
          .catch(() => null);
        if (current !== generation.current) return;
        manualRefresh.current = false;
        if (reply) setTaskReply(reply);
        setLoad({ status: 'ready', snapshot: records.value });
      }
      setReading(false);
      if (runtime.status === 'fulfilled') {
        applyRuntime(runtime.value);
        timer = setTimeout(() => {
          update(false).catch(console.error);
        }, runtime.value.refreshIntervalSeconds * 1000);
      } else {
        const message =
          runtime.reason instanceof Error
            ? runtime.reason.message
            : '采集状态读取失败，刷新可重试';
        setCapture((previous) =>
          'pid' in previous
            ? { ...previous, message }
            : { state: 'error', message },
        );
      }
    };
    update(true).catch(console.error);
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [day, source, refresh, applyRuntime]);
  const control = (action: CaptureAction): void => {
    const currentControl = ++controlGeneration.current;
    setOperation(action);
    bridge
      .controlCapture(action)
      .then((runtime) => {
        // 使在途后台查询失效，再提交按钮操作后的状态。
        generation.current++;
        applyRuntime(runtime);
        if (action === 'start' && 'pid' in runtime.capture) {
          setSource('local');
          setDay(localDay());
          setPage('timeline');
          setFilter('all');
          setSelectedId(null);
        }
        setRefresh((value) => value + 1);
      })
      .catch((error: unknown) => {
        if (currentControl !== controlGeneration.current) return;
        const message = error instanceof Error ? error.message : '采集操作失败';
        setCapture((previous) =>
          'pid' in previous
            ? { ...previous, message }
            : { state: 'error', message },
        );
      })
      .finally(() => {
        if (currentControl === controlGeneration.current) setOperation(null);
      });
  };
  const capturing = 'pid' in capture;
  const captureLabel = {
    stopped: '已停止',
    error: '采集异常',
    unsupported: '仅浏览',
    starting: '启动中',
    running: '采集中',
    stopping: '停止中',
  }[capture.state];
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRetainedTaskSegment(null);
        setSelectedId(null);
        setSelectedSegment(null);
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const snapshot =
    load.status === 'ready' &&
    load.snapshot.day === day &&
    load.snapshot.source === source
      ? load.snapshot
      : source === 'demo'
        ? demoSnapshot(day)
        : emptySnapshot(day);
  // 每日tab档案：统计依据当日已加载记录与任务关系；来源对象保持稳定，避免快照时间逐帧漂移。
  const demoArchiveSnapshot = useMemo(
    () => (source === 'demo' ? demoSnapshot(day) : null),
    [source, day],
  );
  const archiveSnapshot =
    load.status === 'ready' &&
    load.snapshot.day === day &&
    load.snapshot.source === source
      ? load.snapshot
      : demoArchiveSnapshot;
  const dailyReview =
    dailyTab.status === 'ready' &&
    dailyTab.source === source &&
    dailyTab.review.day === day
      ? dailyTab.review
      : null;
  // 档案按数据版本缓存：自动刷新产生的新快照对象若内容未变，不重建档案，保存反馈与快照时间保持稳定。
  const archiveTasks =
    archiveSnapshot && taskReply?.day === archiveSnapshot.day
      ? taskReply
      : null;
  const archiveKey =
    dailyReview && archiveSnapshot && dailyReview.day === archiveSnapshot.day
      ? [
          dailyReview.day,
          dailyReview.generatedAt,
          dailyReview.sourceHash,
          archiveSnapshot.source,
          archiveSnapshot.sourceRevision,
          archiveSnapshot.activities.length,
          archiveTasks?.taskRevision ?? '',
          archiveTasks?.organizing ?? '',
        ].join('|')
      : '';
  const archiveCache = useRef<{ key: string; archive: DailyArchive } | null>(
    null,
  );
  if (!archiveKey) archiveCache.current = null;
  else if (
    archiveCache.current?.key !== archiveKey &&
    dailyReview &&
    archiveSnapshot
  )
    archiveCache.current = {
      key: archiveKey,
      archive: buildDailyArchive(
        dailyReview,
        archiveSnapshot,
        archiveTasks,
        new Date().toISOString(),
      ),
    };
  const dailyArchive = archiveCache.current?.archive ?? null;
  const activities = snapshot.activities.filter(
    (activity) =>
      filter === 'all' || capturedApplicationNames(activity).includes(filter),
  );
  const selected =
    snapshot.activities.find((activity) => activity.id === selectedId) ?? null;
  const taskView = taskReply?.day === day ? taskReply.view : null;
  const pendingCount = taskReply?.day === day ? taskReply.pendingCount : null;
  const organizing = backgrounds?.organizing;
  const organizingDay = organizing?.day ?? day;
  const organizingTitle = organizing?.running
    ? `任务关联整理中 · ${organizingDay}${
        pendingCount !== null && organizingDay === day
          ? ` · 待关联 ${pendingCount} 条`
          : ''
      }`
    : taskReply?.day === day && taskReply.needsOrganization
      ? `任务关联空闲 · 待关联 ${taskReply.pendingCount} 条`
      : '任务关联空闲 · 已同步';
  const backfillTitle = backgrounds?.backfill.running
    ? `整理中${backgrounds.backfill.activeDay ? ` · ${backgrounds.backfill.activeDay}` : ''}`
    : '整理空闲';
  const taskSegment =
    taskView?.segments.find(
      (s) => s.segmentId === (retainedTaskSegment ?? selectedSegment),
    ) ?? null;
  const selectedTask = taskView?.tasks.find(
    (t) => t.taskId === taskSegment?.taskId,
  );
  const navigateTask = (id: string) => {
    const target = taskView?.segments.find((s) => s.segmentId === id);
    if (!target) {
      setTaskNotice('这段记录暂时无法查看');
      return;
    }
    const visible = target.activityIds.some((activityId) =>
      activities.some((a) => a.id === activityId),
    );
    if (!visible) {
      setFilter('all');
      setTaskNotice('已显示当天全部活动');
    }
    setSelectedId(null);
    setRetainedTaskSegment(
      target.taskId ? null : (taskSegment?.segmentId ?? null),
    );
    setSelectedSegment(id);
    setPendingSegment(id);
  };
  const clearLocated = useCallback(() => setPendingSegment(null), []);
  const chooseDay = (value: string) => {
    if (value) {
      review.close();
      setDay(value);
      setSelectedSegment(null);
      setRetainedTaskSegment(null);
      setPendingSegment(null);
      setSelectedId(null);
      setFilter('all');
    }
  };
  const chooseSource = (value: Source) => {
    review.close();
    setSource(value);
    setSelectedSegment(null);
    setRetainedTaskSegment(null);
    setPendingSegment(null);
    setSelectedId(null);
    setFilter('all');
    setPage('timeline');
  };
  const summarizeDay = (): void => {
    review.open(day, source, true).catch(console.error);
  };
  const goPage = (value: Page) => {
    // 在替换内容前保存位置，并在目标页面绘制前恢复各自的位置。
    if (workspaceBody.current) {
      pageScroll.current[page] = workspaceBody.current.scrollTop;
    }
    setPage(value);
    setSelectedId(null);
  };
  return (
    <div className={`app-shell${page === 'backfill' ? ' backfill-shell' : ''}`}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <img className="brand-symbol" src={brandLogoUrl} alt="" />
          <span>明镜</span>
        </div>
        <nav>
          <button
            className={`nav-item ${page === 'timeline' ? 'active' : ''}`}
            onClick={() => goPage('timeline')}
            aria-current={page === 'timeline' ? 'page' : undefined}
          >
            <ListTodo />
            <span>时间线</span>
          </button>
          <button
            className={`nav-item ${page === 'summaries' ? 'active' : ''}`}
            onClick={() => goPage('summaries')}
            aria-current={page === 'summaries' ? 'page' : undefined}
          >
            <FileText />
            <span>回顾</span>
          </button>
          <button
            className={`nav-item ${page === 'backfill' ? 'active' : ''}`}
            onClick={() => goPage('backfill')}
            aria-current={page === 'backfill' ? 'page' : undefined}
          >
            <Images />
            <span>整理</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <p className="sidebar-version">{__OBSERVER_SIDEBAR_VERSION__}</p>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => goPage('settings')}
            aria-current={page === 'settings' ? 'page' : undefined}
          >
            <Settings2 />
            <span>设置</span>
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="toolbar">
          <div className="date-controls">
            <button
              className="icon-button"
              aria-label="前一天"
              onClick={() => chooseDay(moveDay(day, -1))}
            >
              <ArrowLeft size={19} />
            </button>
            <button
              className="today-button"
              onClick={() => chooseDay(localDay())}
            >
              今天
            </button>
            <button
              className="icon-button"
              aria-label="后一天"
              onClick={() => chooseDay(moveDay(day, 1))}
            >
              <ArrowRight size={19} />
            </button>
          </div>
          <div className="date-heading">
            <h1>{dateLabel(day)}</h1>
            <span>{weekday(day)}</span>
          </div>
          <div className="toolbar-actions">
            <div className="status-balls" aria-label="后台作业状态">
              <span
                className={`status-ball${organizing?.running ? ' running' : ''}`}
                role="status"
                title={organizingTitle}
              >
                <i />
                关联
              </span>
              <span
                className={`status-ball${backgrounds?.backfill.running ? ' running' : ''}`}
                role="status"
                title={backfillTitle}
              >
                <i />
                整理
              </span>
            </div>
            <div className={`capture-control ${capture.state}`}>
              <span
                className="capture-status"
                role="status"
                title={capture.message}
              >
                <i />
                {captureLabel}
              </span>
              <button
                className="capture-button"
                disabled={
                  (controlling && !changingAnalysis) ||
                  capture.state === 'unsupported'
                }
                onClick={() => control(capturing ? 'stop' : 'start')}
                aria-label={capturing ? '停止截屏' : '开始截屏'}
              >
                {capturing ? <Square size={13} /> : <Play size={14} />}
                {capture.state === 'stopping'
                  ? operation === 'stop'
                    ? '停止中'
                    : '重试停止'
                  : capturing
                    ? '停止截屏'
                    : '开始截屏'}
              </button>
              <button
                className="capture-button analysis-button"
                role="switch"
                aria-label="开启分析"
                aria-checked={analysisEnabled}
                disabled={
                  controlling ||
                  capture.state === 'stopping' ||
                  capture.state === 'unsupported'
                }
                title="开启后分析图片并保存活动和总结；关闭时取消当前分析，继续保存截图。"
                onClick={() =>
                  control(
                    analysisEnabled ? 'disable-analysis' : 'enable-analysis',
                  )
                }
              >
                <CodeXml size={14} />
                {changingAnalysis
                  ? '分析切换中'
                  : analysisEnabled
                    ? '分析已开启'
                    : '分析已关闭'}
              </button>
            </div>
            <label className="calendar-control" title="选择日期">
              <CalendarDays size={18} />
              <input
                aria-label="选择日期"
                type="date"
                value={day}
                onChange={(event) => chooseDay(event.target.value)}
              />
            </label>
            <span className="source-badge">
              <i />
              {source === 'demo' ? '测试数据' : '本地记录'}
            </span>
            <button
              className="icon-button"
              aria-label="刷新记录"
              onClick={() => {
                manualRefresh.current = true;
                setRefresh((value) => value + 1);
              }}
            >
              <RefreshCw size={17} className={reading ? 'spinning' : ''} />
            </button>
          </div>
        </header>
        <LocalBuildNotice bridge={bridge} />
        <div
          className={`capture-progress ${capture.state}`}
          title={capture.message}
        >
          {'mode' in capture &&
            (capture.mode === 'capture-only' ? '仅截屏 · ' : '截图与分析 · ')}
          {capture.message}
        </div>
        {page === 'timeline' && (
          <div className="filters" aria-label="应用筛选">
            <button
              className={filter === 'all' ? 'filter selected' : 'filter'}
              onClick={() => {
                setFilter('all');
                setSelectedId(null);
              }}
            >
              全部应用
            </button>
            {appCounts(snapshot).map(([name]) => (
              <button
                key={name}
                className={filter === name ? 'filter selected' : 'filter'}
                onClick={() => {
                  setFilter(name);
                  setSelectedId(null);
                }}
              >
                <i className={`app-dot ${accent(name)}`} />
                {name}
              </button>
            ))}
          </div>
        )}
        <div className="workspace-body" ref={workspaceBody}>
          <div hidden={page !== 'backfill'} className="backfill-container">
            <BackfillPage
              bridge={bridge}
              active={page === 'backfill'}
              refreshIntervalSeconds={refreshIntervalSeconds}
              association={{
                day,
                reply: taskReply,
                running: backgrounds?.organizing ?? null,
              }}
            />
          </div>
          {page !== 'backfill' && load.status === 'error' && (
            <div className="issue-banner" role="alert">
              {load.message}，可点击右上角刷新。
            </div>
          )}
          {page !== 'backfill' && snapshot.issues.length > 0 && (
            <div className="issue-banner" role="alert">
              {snapshot.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          )}
          {page === 'timeline' && taskReply?.organizing === 'running' && (
            <p className="muted">正在关联当天任务，已有记录可继续查看。</p>
          )}
          {page === 'timeline' &&
            taskReply?.issues.map((issue) => (
              <p role="status" className="issue-banner" key={issue}>
                {issue}
              </p>
            ))}
          {page === 'timeline' && taskNotice && (
            <p role="status" className="issue-banner">
              {taskNotice}
            </p>
          )}
          {page === 'timeline' && taskView && taskView.tasks.length > 0 ? (
            <TaskTimeline
              view={taskView}
              activities={snapshot.activities}
              filter={filter}
              selected={selectedSegment}
              onSelect={(id) => {
                setRetainedTaskSegment(null);
                const segment = taskView.segments.find(
                  (s) => s.segmentId === id,
                );
                setSelectedFrame(undefined);
                setSelectedId(
                  segment?.taskId ? null : (segment?.activityIds[0] ?? null),
                );
                setSelectedSegment(id);
              }}
              pending={pendingSegment}
              onLocated={clearLocated}
              onImage={showImage}
              maxGapSeconds={groupingGapSeconds}
            />
          ) : (
            page === 'timeline' && (
              <Timeline
                activities={activities}
                selectedId={selectedId}
                onSelect={showImage}
                loading={load.status === 'loading'}
                source={source}
                filtered={filter !== 'all'}
              />
            )
          )}
          {page === 'summaries' && (
            <section className="content-page">
              <div
                className="summary-tabs"
                role="tablist"
                aria-label="总结类型"
              >
                <button
                  role="tab"
                  className={`summary-tab${summaryTab === 'periodic' ? ' selected' : ''}`}
                  aria-selected={summaryTab === 'periodic'}
                  onClick={() => setSummaryTab('periodic')}
                >
                  半小时总结
                </button>
                <button
                  role="tab"
                  className={`summary-tab${summaryTab === 'daily' ? ' selected' : ''}`}
                  aria-selected={summaryTab === 'daily'}
                  onClick={() => setSummaryTab('daily')}
                >
                  每日总结
                </button>
              </div>
              {summaryTab === 'periodic' && (
                <>
                  <div className="eyebrow">DAILY NOTES</div>
                  <h2>活动总结</h2>
                  <p className="muted">
                    {source === 'demo'
                      ? '【测试数据】以下为界面演示内容。'
                      : '查看这一天已保存的周期总结。'}
                  </p>
                  {snapshot.summaries.length === 0 ? (
                    <Empty
                      title="这一天暂无总结"
                      text="有新的总结后，刷新即可查看。"
                    />
                  ) : (
                    snapshot.summaries.map((summary) => (
                      <article
                        className="summary-card"
                        key={`${summary.windowStart}-${summary.generatedAt}`}
                      >
                        <span className="eyebrow">
                          {clock(summary.windowStart)} —{' '}
                          {clock(summary.windowEnd)}
                        </span>
                        <p>{summary.summary}</p>
                        {summary.gaps.length > 0 && (
                          <span className="muted">
                            该时段包含 {summary.gaps.length} 段观察缺口
                          </span>
                        )}
                      </article>
                    ))
                  )}
                </>
              )}
              {summaryTab === 'daily' && (
                <DailySummary
                  day={day}
                  view={dailyView}
                  state={dailyTab}
                  archive={dailyArchive}
                  source={source}
                  busy={
                    dailyView?.phase === 'running' ||
                    (review.dialog?.day === day &&
                      review.dialog.source === source &&
                      review.dialog.busy)
                  }
                  saveImage={bridge.saveArchiveImage}
                  onRegenerate={summarizeDay}
                />
              )}
            </section>
          )}
          <section
            hidden={page !== 'settings'}
            className="content-page settings-page"
          >
            <div className="eyebrow">PREFERENCES</div>
            <h2>设置</h2>
            <p className="muted">
              调整分析、截图和全部运行参数，保存后按提示生效。
            </p>
            <SettingsEditor
              bridge={bridge}
              onSaved={() => setRefresh((value) => value + 1)}
            />
            <h3>数据来源</h3>
            <button
              className={`source-option ${source === 'demo' ? 'chosen' : ''}`}
              onClick={() => chooseSource('demo')}
            >
              <span>
                <strong>测试预览</strong>
                <small>使用标有【测试数据】的虚拟活动，预览客户端界面。</small>
              </span>
              {source === 'demo' && <Check size={20} />}
            </button>
            <button
              className={`source-option ${source === 'local' ? 'chosen' : ''}`}
              onClick={() => chooseSource('local')}
            >
              <span>
                <strong>本地记录</strong>
                <small>只读查看 scening 保存的活动、截图和总结。</small>
              </span>
              {source === 'local' && <Check size={20} />}
            </button>
            <div className="settings-note">
              <h3>记录与采集</h3>
              <p>
                开始截屏按分析开关选择运行模式，并切换到今天的本地记录。本地记录自动更新，刷新可随时手动重读。
              </p>
              <p>
                分析开启后生成活动与总结，关闭后取消当前分析并继续保存截图。开关在同一采集进程内生效，已保存图片与记录保留。
              </p>
              <p>
                停止截屏会取消当前分析、回收任务并完成当前文件提交。关闭窗口保留采集，退出应用会停止本客户端启动的采集；独立进程由“停止截屏”控制。
              </p>
              <p className="path-label">配置位置</p>
              <code>
                {snapshot.locations.configPath || '项目根目录 / observer.yaml'}
              </code>
              {snapshot.locations.home && (
                <>
                  <p className="path-label">活动与总结</p>
                  <code>{snapshot.locations.home}</code>
                </>
              )}
              {snapshot.locations.screenshotDir && (
                <>
                  <p className="path-label">截图位置</p>
                  <code>{snapshot.locations.screenshotDir}</code>
                </>
              )}
            </div>
            <p className="version">Observer · {__OBSERVER_VERSION__}</p>
          </section>
        </div>
      </main>
      <aside
        className={`inspector ${selected || selectedTask ? 'has-selection' : ''}`}
        aria-label={
          selected ? '活动详情' : selectedTask ? '任务详情' : '当日概览'
        }
      >
        {taskView && taskSegment && selectedTask && !selected ? (
          <TaskDetails
            key={selectedTask.taskId}
            view={taskView}
            segment={taskSegment}
            activities={snapshot.activities}
            onClose={() => {
              setSelectedSegment(null);
              setRetainedTaskSegment(null);
            }}
            onNavigate={navigateTask}
            onImage={showImage}
          />
        ) : selected ? (
          <Details
            key={`${selected.id}:${String(selectedFrame)}`}
            activity={selected}
            frameIndex={selectedFrame}
            source={source}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <Overview
            snapshot={snapshot}
            hasReview={dailyArchive !== null}
            onShowReview={() => {
              if (dailyArchive) review.show(dailyArchive, dailyView);
            }}
          />
        )}
      </aside>
      {review.dialog && (
        <DailyReviewModal
          archive={review.dialog.archive}
          day={review.dialog.day}
          view={review.dialog.view}
          saveImage={bridge.saveArchiveImage}
          onRegenerate={review.regenerate}
          issue={review.dialog.issue}
          regenerating={review.dialog.busy}
          onPresented={review.presented}
          onReturn={() => {
            review.close();
            setPage('timeline');
          }}
          onClose={review.close}
        />
      )}
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <ListTodo size={30} strokeWidth={1.3} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

/** 总结页每日tab：只读已保存回顾并以当日档案样式呈现，生成与保存图片均由底部按钮显式触发。 */
function DailySummary({
  day,
  view,
  state,
  source,
  busy,
  onRegenerate,
  archive,
  saveImage,
}: {
  day: string;
  view: DailyReviewView | null;
  state: DailyTabState;
  source: Source;
  busy: boolean;
  onRegenerate: () => void;
  archive: DailyArchive | null;
  saveImage: (archive: DailyArchive) => Promise<ArchiveImageReply>;
}) {
  const error = view?.lastError;
  const details = error
    ? error.details === error.message
      ? error.message
      : `${error.message}\n${error.details}`
    : state.status === 'error'
      ? state.message
      : null;
  const ongoing = day >= localDay();
  const showButton =
    state.status !== 'ready' &&
    state.status !== 'loading' &&
    source === 'local' &&
    view !== null;
  const beforeDue = view && new Date(view.dueAt).getTime() > Date.now();
  let body: ReactNode = null;
  if (state.status === 'ready') {
    body = archive ? (
      <DailyArchiveSheet
        archive={archive}
        busy={busy}
        onRegenerate={onRegenerate}
        saveImage={saveImage}
      />
    ) : (
      <Empty title="正在读取每日总结" text="稍等片刻。" />
    );
  } else if (state.status === 'loading') {
    body = <Empty title="正在读取每日总结" text="稍等片刻。" />;
  } else if (ongoing) {
    body = (
      <div className="daily-pending-message">
        {Number(day.slice(-2))}号结束后会在第二天自动总结
        {view && (
          <p className="muted">
            计划时间：{view.dueAt.slice(0, 10)} {view.dueAt.slice(11, 16)}
          </p>
        )}
      </div>
    );
  } else if (beforeDue) {
    body = (
      <Empty
        title="待生成"
        text={`计划时间：${view.dueAt.slice(0, 10)} ${view.dueAt.slice(11, 16)}`}
      />
    );
  } else if (busy) {
    body = (
      <Empty
        title="正在生成每日总结"
        text="已保存分析正在汇总，其他分析继续进行。"
      />
    );
  } else if (view?.phase === 'waiting_retry') {
    body = (
      <Empty
        title="等待自动重试"
        text={`已自动尝试 ${view.autoAttempts}/${view.maxAutoAttempts} 次，下次：${view.nextAttemptAt ?? ''}`}
      />
    );
  } else if (!showButton && !details) {
    body = <Empty title="当日无记录" text="已有分析后可生成该日总结。" />;
  }
  return (
    <div className="daily-summary-state">
      <div className="eyebrow">DAILY REVIEW</div>
      <h2>每日总结</h2>
      <p className="muted">
        {source === 'demo'
          ? '【测试数据】以下为界面演示内容。'
          : '依据这一天已经保存的分析与周期总结生成回顾，部分分析也可总结。'}
      </p>
      {details && (
        <div className="daily-error-details" role="alert">
          <strong>总结生成失败</strong>
          {error && (
            <p>
              失败时间：{error.occurredAt} · 自动已尝试 {view.autoAttempts} 次
            </p>
          )}
          <pre>{details}</pre>
        </div>
      )}
      {view?.persistenceError && (
        <div className="daily-error-details" role="alert">
          <strong>状态保存失败</strong>
          <pre>{view.persistenceError.details}</pre>
        </div>
      )}
      {body}
      {showButton && (
        <div className="daily-empty-actions">
          <button
            className="daily-review-button daily-center-summary"
            disabled={busy}
            onClick={onRegenerate}
          >
            <RefreshCw size={15} className={busy ? 'spinning' : ''} />
            {busy ? '总结中' : '生成总结'}
          </button>
        </div>
      )}
    </div>
  );
}

function Timeline({
  activities,
  selectedId,
  onSelect,
  loading,
  source,
  filtered,
}: {
  activities: TimelineActivity[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  source: Source;
  filtered: boolean;
}) {
  if (activities.length === 0)
    return (
      <Empty
        title={
          loading
            ? '正在读取记录'
            : filtered
              ? '当前筛选暂无活动'
              : '这一天暂无活动'
        }
        text={
          loading
            ? '稍等片刻，时间线即将呈现。'
            : filtered
              ? '选择其他应用，查看已记录的活动。'
              : source === 'local'
                ? '选择其他日期，或在记录更新后刷新。'
                : '选择其他应用，查看测试活动。'
        }
      />
    );
  const first = Math.floor(
    Math.min(...activities.map((item) => minutes(item.start))) / 60,
  );
  const last = Math.min(
    23,
    Math.max(
      first + 5,
      Math.floor(Math.max(...activities.map((item) => minutes(item.end))) / 60),
    ),
  );
  const hours = Array.from(
    { length: last - first + 1 },
    (_, index) => first + index,
  );
  return (
    <section className="timeline" aria-label="活动时间线">
      <div className="timeline-note">
        {source === 'demo'
          ? '【测试数据】虚拟活动，仅供界面预览'
          : '按采集时的本地时间排列 · 自动更新'}
      </div>
      {hours.map((hour) => (
        <div className="timeline-hour" key={hour}>
          <div className="hour-label">{String(hour).padStart(2, '0')}:00</div>
          <div className="hour-content">
            {activities
              .filter((item) => Math.floor(minutes(item.start) / 60) === hour)
              .map((activity) => (
                <button
                  key={activity.id}
                  className={`activity-card ${accent(appName(activity))} ${selectedId === activity.id ? 'selected-card' : ''}`}
                  onClick={() => onSelect(activity.id)}
                  aria-pressed={selectedId === activity.id}
                  data-testid="activity-card"
                >
                  <span className="card-accent" />
                  <div className="card-icon">
                    <AppIcon name={appName(activity)} size={21} />
                  </div>
                  <div className="card-body">
                    <div className="card-metadata">
                      <div className="activity-card-context">
                        <span>{appName(activity)}</span>
                        <time>{activityTime(activity)}</time>
                      </div>
                      <TaskTypeLabels activities={[activity]} />
                    </div>
                    <h3>{activity.title}</h3>
                    <p>{cardPreview(activity.analysis)}</p>
                  </div>
                  <ChevronRight className="card-chevron" size={16} />
                </button>
              ))}
          </div>
        </div>
      ))}
      <div className="timeline-end">
        <span />
        {source === 'demo' ? '测试时间线' : '以上为已保存记录'}
      </div>
    </section>
  );
}

function Overview({
  snapshot,
  hasReview,
  onShowReview,
}: {
  snapshot: Snapshot;
  hasReview: boolean;
  onShowReview: () => void;
}) {
  const counts = appCounts(snapshot);
  const maximum = Math.max(1, ...counts.map(([, count]) => count));
  const latest = snapshot.summaries.at(-1);
  return (
    <div className="overview">
      <div className="inspector-heading">
        <div className="eyebrow">YOUR DAY, AT A GLANCE</div>
        <div className="overview-title-row">
          <h2>当日概览</h2>
          {hasReview && (
            <button className="daily-review-button" onClick={onShowReview}>
              展示总结
            </button>
          )}
        </div>
      </div>
      {snapshot.source === 'demo' && (
        <div className="demo-label">【测试数据】概览</div>
      )}
      <div className="day-metrics">
        <div>
          <strong>{snapshot.activities.length}</strong>
          <span>活动记录</span>
        </div>
        <div>
          <strong>
            {counts.filter(([name]) => name !== '未知应用').length}
          </strong>
          <span>使用应用</span>
        </div>
      </div>
      <section className="overview-section">
        <h3>应用分布</h3>
        {counts.length === 0 ? (
          <p className="muted">当日暂无应用记录</p>
        ) : (
          counts.map(([name, count]) => (
            <div className="app-distribution" key={name}>
              <span title={name}>{name}</span>
              <div className="bar-track">
                <i
                  className={accent(name)}
                  style={{ width: `${(count / maximum) * 100}%` }}
                />
              </div>
              <small>{count}条</small>
            </div>
          ))
        )}
      </section>
      <section className="overview-section latest-summary">
        <h3>最近总结</h3>
        {latest ? (
          <>
            <time>{clock(latest.generatedAt)}</time>
            <p>{latest.summary}</p>
            <span className="summary-caption">
              依据已保存活动 · {clock(latest.windowStart)} —{' '}
              {clock(latest.windowEnd)}
            </span>
          </>
        ) : (
          <p className="muted">这一天暂无已保存总结。</p>
        )}
      </section>
      <div className="inspector-hint">
        <ImageIcon size={20} strokeWidth={1.4} />
        <span>点击时间线卡片查看详情</span>
      </div>
    </div>
  );
}

function Details({
  activity,
  source,
  frameIndex,
  onClose,
}: {
  activity: TimelineActivity;
  source: Source;
  frameIndex: number | undefined;
  onClose: () => void;
}) {
  const [frame, setFrame] = useState(frameIndex);
  const [loadedImage, setLoadedImage] = useState<{
    key: string;
    result: ImageResult;
  } | null>(null);
  const imageKey = `${source}:${activity.id}:${String(frame)}`;
  const image = loadedImage?.key === imageKey ? loadedImage.result : null;
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let current = true;
    if (source === 'local')
      bridge
        .readImage(activity.id, frame)
        .then((result) => {
          if (current) setLoadedImage({ key: imageKey, result });
        })
        .catch(() => {
          if (current)
            setLoadedImage({
              key: imageKey,
              result: {
                status: 'missing',
                message: '截图读取失败，活动正文仍可查看。',
              },
            });
        });
    return () => {
      current = false;
    };
  }, [activity.id, source, frame, imageKey]);
  return (
    <div className="details">
      <div className="detail-top">
        <span className="eyebrow">ACTIVITY DETAIL</span>
        <button className="icon-button" aria-label="关闭详情" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <h2>活动详情</h2>
      <div className={`detail-app ${accent(appName(activity))}`}>
        <AppIcon name={appName(activity)} />
        <span>{appName(activity)}</span>
      </div>
      <h3 className="detail-title">{activity.title}</h3>
      <TaskTypeLabels activities={[activity]} />
      <div className="detail-time">
        <CalendarDays size={15} />
        <span>
          {dateLabel(activity.start.slice(0, 10))} · {activityTime(activity)}
        </span>
      </div>
      {activity.frames?.length ? (
        <div className="frame-picker" aria-label="选择记录截图">
          <button
            type="button"
            className="text-button"
            aria-pressed={frame === undefined}
            onClick={() => setFrame(undefined)}
          >
            整组截图
          </button>
          {activity.frames.map((item, index) => (
            <button
              type="button"
              className="text-button"
              key={`${item.capturedAt}:${String(index)}`}
              aria-pressed={frame === index + 1}
              onClick={() => setFrame(index + 1)}
            >
              图{index + 1}
            </button>
          ))}
        </div>
      ) : null}
      <div className="screenshot-box">
        {source === 'demo' ? (
          <div className="demo-screenshot">
            <div className="mini-window">
              <div className="mini-titlebar">
                <i />
                <i />
                <i />
              </div>
              <div className="mini-content">
                <div className="mini-rail" />
                <div className="mini-lines">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
            <span>{TEST_PREFIX}截图占位</span>
          </div>
        ) : image?.status === 'ready' ? (
          <button
            className="screenshot-open"
            aria-label="放大截图"
            onClick={() => setZoom(true)}
          >
            <img
              src={image.dataUrl}
              alt={frame ? `原始截图 图${String(frame)}` : '本组分析截图'}
            />
          </button>
        ) : (
          <div className="missing-image">
            <ImageIcon size={28} strokeWidth={1.3} />
            <span>
              {image?.status === 'missing' ? image.message : '正在读取截图'}
            </span>
          </div>
        )}
      </div>
      <section className="detail-analysis">
        <h3>活动记录</h3>
        <p>{activity.analysis}</p>
      </section>
      <div className="detail-source">
        {source === 'demo'
          ? '【测试数据】虚拟内容，用于预览界面'
          : '本地记录 · 来自已保存的屏幕观察'}
      </div>
      {zoom && image?.status === 'ready' && (
        <div className="image-lightbox" role="dialog" aria-label="截图预览">
          <button
            className="icon-button"
            aria-label="关闭截图预览"
            onClick={() => setZoom(false)}
          >
            <X size={24} />
          </button>
          <img src={image.dataUrl} alt="原始截图预览" />
        </div>
      )}
    </div>
  );
}
