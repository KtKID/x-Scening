import { createRoot } from 'react-dom/client';
import { BackfillPage } from '../src/renderer/src/BackfillPage';
import { localDay, moveDay } from '../src/shared/protocol';
import type { BackfillStatus, ObserverBridge } from '../src/shared/protocol';
import {
  BackfillStatusSchema,
  TimelineReadReplySchema,
} from '../src/shared/scening.generated';
import type { z } from 'zod';

type TaskReply = z.infer<typeof TimelineReadReplySchema>;
type Update = {
  backfill?: Partial<BackfillStatus>;
  task?: Partial<TaskReply>;
  taskDay?: string;
  running?: { running: boolean; day: string | null } | null;
  active?: boolean;
  readError?: boolean;
  controlError?: boolean;
  holdRead?: boolean;
  directoryError?: boolean;
};
type Call = { day: string; action: 'start' | 'stop' };
type Fixture = {
  reset: () => void;
  update: (value: Update) => void;
  calls: Call[];
  reads: number;
  directoryOpens: number;
};
declare global {
  interface Window {
    pipelineFixture: Fixture;
  }
}

const mount = document.getElementById('root');
if (!mount) throw new Error('缺少界面夹具入口');
const root = createRoot(mount);
const day = moveDay(localDay(), -1);
let epoch = 0;
let backfill: BackfillStatus;
let task: TaskReply;
let taskDay = day;
let running: Update['running'] = null;
let active = true;
let readError = false;
let controlError = false;
let holdRead = false;
let directoryError = false;

const bridge: Pick<
  ObserverBridge,
  'readBackfill' | 'controlBackfill' | 'screenshotDirectory'
> = {
  screenshotDirectory(action) {
    if (action === 'open') {
      window.pipelineFixture.directoryOpens++;
      if (directoryError) return Promise.reject(new Error('夹具目录缺失'));
    }
    return Promise.resolve('/tmp/scening 测试/截图保存目录');
  },
  readBackfill(query) {
    window.pipelineFixture.reads++;
    if (readError) return Promise.reject(new Error('夹具核对失败'));
    if (holdRead) return new Promise<BackfillStatus>(() => {});
    return Promise.resolve({ ...backfill, day: query.day });
  },
  controlBackfill(query) {
    window.pipelineFixture.calls.push(query);
    if (controlError) return Promise.reject(new Error('夹具控制失败'));
    backfill = BackfillStatusSchema.parse({
      ...backfill,
      day: query.day,
      state: query.action === 'start' ? 'running' : 'cancelled',
      owned: query.action === 'start',
      activeDay: query.action === 'start' ? query.day : null,
      planned: 6,
      processed: 0,
    });
    return Promise.resolve(backfill);
  },
};
function render(): void {
  root.render(
    <BackfillPage
      key={epoch}
      bridge={bridge}
      active={active}
      refreshIntervalSeconds={0.05}
      association={{ day: taskDay, reply: task, running: running ?? null }}
    />,
  );
}
function reset(): void {
  epoch++;
  backfill = BackfillStatusSchema.parse({
    day,
    state: 'idle',
    total: 9,
    analyzed: 3,
    remaining: 6,
    eligible: true,
    message: '点击开始，应用会自动补齐待分析截图。',
    owned: false,
    activeDay: null,
  });
  task = TimelineReadReplySchema.parse({
    day,
    sourceRevision: 'source-1',
    semanticRevision: 'semantic-1',
    needsOrganization: true,
    pendingCount: 2,
    evidenceRevision: '',
    taskRevision: 'task-1',
    organizing: 'idle',
    coveredUntil: null,
    view: null,
    issues: [],
  });
  taskDay = day;
  running = null;
  active = true;
  readError = false;
  controlError = false;
  holdRead = false;
  directoryError = false;
  window.pipelineFixture.calls.length = 0;
  window.pipelineFixture.reads = 0;
  window.pipelineFixture.directoryOpens = 0;
  render();
}
window.pipelineFixture = {
  directoryOpens: 0,
  reset,
  update(value) {
    if (value.directoryError !== undefined)
      directoryError = value.directoryError;
    if (value.backfill)
      backfill = BackfillStatusSchema.parse({ ...backfill, ...value.backfill });
    if (value.task)
      task = TimelineReadReplySchema.parse({ ...task, ...value.task });
    if (value.taskDay !== undefined) taskDay = value.taskDay;
    if (value.running !== undefined) running = value.running;
    if (value.active !== undefined) active = value.active;
    if (value.readError !== undefined) readError = value.readError;
    if (value.controlError !== undefined) controlError = value.controlError;
    if (value.holdRead !== undefined) holdRead = value.holdRead;
    render();
  },
  calls: [],
  reads: 0,
};
reset();
