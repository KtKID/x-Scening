import { useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  FolderOpen,
  Images,
  Network,
  ScanLine,
} from 'lucide-react';
import type { z } from 'zod';
import { localDay, moveDay } from '../../shared/protocol';
import type { BackfillStatus, ObserverBridge } from '../../shared/protocol';
import type { TimelineReadReplySchema } from '../../shared/scening.generated';

const labels: Record<BackfillStatus['state'], string> = {
  idle: '待补分析',
  running: '补分析中',
  completed: '全部已分析',
  partial: '还有截图待分析',
  cancelled: '已停止',
  failed: '补分析中断',
  empty: '这一天暂无截图',
  error: '核对失败',
};

/** 任务关联跟随时间线当前查看日期，这里只读展示其进度。 */
type Association = {
  day: string;
  reply: z.infer<typeof TimelineReadReplySchema> | null;
  running: { running: boolean; day: string | null } | null;
};

/** 仅在已取得的同页数据之间比较增量；页面重新显示时重新建立基线。 */
type PipelineSnapshot = {
  day: string;
  taskDay: string;
  analyzed: number | null;
  taskRevision: string | null;
};

/** 一次真实更新对应一个光点，结束或减弱动态时释放，避免布局变化重播。 */
function PipelinePacket() {
  const [finished, setFinished] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = (): void => {
      if (motion.matches) setFinished(true);
    };
    motion.addEventListener('change', stop);
    return () => motion.removeEventListener('change', stop);
  }, []);
  return finished ? null : (
    <i className="pipeline-packet" onAnimationEnd={() => setFinished(true)} />
  );
}

function associationLabel(
  association: Association,
  reply: Association['reply'],
): string {
  if (association.running?.running) return '整理中';
  if (!reply) return '正在读取';
  if (reply.organizing === 'failed') return '整理失败';
  if (reply.organizing === 'disabled') return '已停用';
  if (reply.needsOrganization) return '等待整理';
  return '已同步';
}

/** 显示当前配置的截图根目录，打开动作独立于补分析作业。 */
function ScreenshotDirectory({
  directory,
}: {
  directory: ObserverBridge['screenshotDirectory'];
}) {
  const [location, setLocation] = useState('');
  const [issue, setIssue] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let current = true;
    directory('read')
      .then((value) => {
        if (current) setLocation(value);
      })
      .catch(() => {
        if (current) setIssue('截图保存路径暂不可用。');
      });
    return () => {
      current = false;
    };
  }, [directory]);
  const open = (): void => {
    setOpening(true);
    setIssue('');
    directory('open')
      .then(setLocation)
      .catch(() => setIssue('无法打开截图保存目录，请确认目录存在且可访问。'))
      .finally(() => setOpening(false))
      .catch(console.error);
  };
  return (
    <div className="backfill-location">
      <div className="backfill-location-copy">
        <p>截图保存路径</p>
        {location && <code>{location}</code>}
        {issue && (
          <p className="muted" role="alert">
            {issue}
          </p>
        )}
      </div>
      <button
        type="button"
        className="backfill-button backfill-location-button"
        disabled={!location || opening}
        aria-busy={opening}
        onClick={open}
      >
        <FolderOpen size={16} aria-hidden="true" />
        打开保存目录
      </button>
    </div>
  );
}

/** 独立日期与补分析按钮；隐藏后保留选择，作业由主进程继续管理。 */
export function BackfillPage({
  bridge,
  active,
  refreshIntervalSeconds,
  association,
}: {
  bridge: Pick<
    ObserverBridge,
    'readBackfill' | 'controlBackfill' | 'screenshotDirectory'
  >;
  active: boolean;
  refreshIntervalSeconds: number | null;
  association: Association;
}) {
  const [day, setDay] = useState(() => moveDay(localDay(), -1));
  const [reply, setReply] = useState<BackfillStatus | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [transfers, setTransfers] = useState({ analysis: 0, association: 0 });
  const previous = useRef<PipelineSnapshot | null>(null);
  const resolvedRead = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    resolvedRead.current = false;
    previous.current = null;
    setTransfers({ analysis: 0, association: 0 });
    if (!active) return;
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async (): Promise<void> => {
      try {
        const result = await bridge.readBackfill({ day });
        if (current !== generation.current) return;
        if (result.activeDay && result.activeDay !== day) {
          setDay(result.activeDay);
          return;
        }
        resolvedRead.current = true;
        setReply(result);
        setError('');
      } catch {
        if (current !== generation.current) return;
        setError('核对失败，请重新核对。');
      }
      if (current === generation.current && refreshIntervalSeconds !== null)
        timer = setTimeout(() => {
          update().catch(console.error);
        }, refreshIntervalSeconds * 1000);
    };
    update().catch(console.error);
    return () => {
      resolvedRead.current = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [active, bridge, day, refresh, refreshIntervalSeconds]);
  const status = reply?.day === day ? reply : null;
  const running = status?.state === 'running';
  const dateLocked = busy || !!status?.activeDay || running;
  const progressPercent =
    status &&
    status.total !== null &&
    status.total > 0 &&
    status.analyzed !== null &&
    !error
      ? Math.min(100, Math.floor((status.analyzed / status.total) * 1000) / 10)
      : null;
  const otherDay = status?.activeDay && status.activeDay !== day;
  const retryCheck = error !== '' || status?.state === 'error';
  const disabled =
    busy ||
    (!retryCheck &&
      (!status ||
        !!otherDay ||
        (running ? !status.owned : !status.eligible || !status.remaining)));
  const buttonLabel = busy
    ? '正在处理…'
    : retryCheck
      ? '重新核对'
      : !status
        ? '正在核对…'
        : running
          ? status.owned
            ? '停止补分析'
            : '补分析中'
          : otherDay
            ? '其他日期处理中'
            : status.state === 'completed'
              ? '全部已分析'
              : status.state === 'empty'
                ? '暂无截图'
                : !status.eligible
                  ? '请选择今天或更早日期'
                  : ['partial', 'cancelled', 'failed'].includes(status.state)
                    ? '继续补分析'
                    : '开始补分析';
  const action = (): void => {
    if (retryCheck) {
      setRefresh((value) => value + 1);
      return;
    }
    if (!status || disabled) return;
    const current = ++generation.current;
    setBusy(true);
    bridge
      .controlBackfill({ day, action: running ? 'stop' : 'start' })
      .then((result) => {
        if (current === generation.current) {
          setReply(result);
          setError('');
        }
      })
      .catch(() => {
        if (current === generation.current)
          setError('操作结果暂时无法读取，请重新核对。');
      })
      .finally(() => {
        setBusy(false);
        setRefresh((value) => value + 1);
      });
  };
  const organizingNow = association.running?.running === true;
  const taskDay =
    (organizingNow && association.running?.day) || association.day;
  const taskReply =
    association.reply?.day === taskDay ? association.reply : null;
  const associationIssue = taskReply?.issues[0];
  const sameDay = day === taskDay;
  const associationAvailable =
    taskReply !== null &&
    taskReply.organizing !== 'disabled' &&
    taskReply.organizing !== 'failed';
  useEffect(() => {
    if (!active || !resolvedRead.current || !status || error) {
      previous.current = null;
      setTransfers({ analysis: 0, association: 0 });
      return;
    }
    const current: PipelineSnapshot = {
      day,
      taskDay,
      analyzed: status.analyzed,
      taskRevision: taskReply?.taskRevision || null,
    };
    const prior = previous.current;
    previous.current = current;
    if (!prior || prior.day !== day || prior.taskDay !== taskDay) {
      setTransfers({ analysis: 0, association: 0 });
      return;
    }
    const saved =
      prior.analyzed !== null &&
      current.analyzed !== null &&
      current.analyzed > prior.analyzed;
    const associated =
      prior.taskRevision !== null &&
      current.taskRevision !== null &&
      current.taskRevision !== prior.taskRevision;
    if (saved || associated)
      setTransfers((value) => ({
        analysis: value.analysis + (saved ? 1 : 0),
        association:
          sameDay && associationAvailable ? value.association + 1 : 0,
      }));
    else if (!associationAvailable)
      setTransfers((value) =>
        value.association === 0 ? value : { ...value, association: 0 },
      );
  }, [
    active,
    day,
    taskDay,
    status,
    taskReply,
    sameDay,
    associationAvailable,
    error,
  ]);

  return (
    <section className="content-page backfill-page" aria-label="补分析页面">
      <header className="backfill-header">
        <div>
          <h2>整理</h2>
          <p className="muted">让截图成为活动，让活动串成任务</p>
        </div>
        <label className="backfill-date">
          截图日期
          <span
            className="backfill-date-control"
            title={
              dateLocked
                ? '补分析期间固定此日期，结束后可切换。'
                : '选择截图日期'
            }
          >
            <input
              type="date"
              aria-label="补分析日期"
              value={day}
              disabled={dateLocked}
              onChange={(event) => {
                if (event.target.value) {
                  setDay(event.target.value);
                  setError('');
                }
              }}
            />
            <CalendarDays className="backfill-date-icon" aria-hidden="true" />
          </span>
        </label>
      </header>
      <div className="backfill-pipeline" aria-label="截图分析与任务关联流水线">
        <section
          className="backfill-stage backfill-source"
          aria-label="本地截图"
        >
          <div className="pipeline-node">
            <Images aria-hidden="true" />
          </div>
          <h3>本地截图</h3>
          <p className="pipeline-value">
            {status?.total ?? '—'}
            <span>张</span>
          </p>
          <p className="pipeline-detail">{day}</p>
          <p className="pipeline-state">
            {status?.total === null || error
              ? '等待核对'
              : status
                ? '本地已读取'
                : '正在读取'}
          </p>
        </section>
        <div
          className="pipeline-transfer"
          data-revision={transfers.analysis}
          aria-hidden="true"
        >
          {active && transfers.analysis > 0 && (
            <PipelinePacket key={transfers.analysis} />
          )}
        </div>
        <section
          className={`backfill-stage backfill-result ${status?.state ?? ''}`}
          aria-label="补分析进度"
        >
          <div className="pipeline-node">
            <ScanLine aria-hidden="true" />
          </div>
          <h3>补分析</h3>
          <p className="pipeline-value">
            {status?.analyzed ?? '—'}
            <span>/ {status?.total ?? '—'} 张</span>
          </p>
          <p className="pipeline-detail">
            {status?.remaining !== null && status?.remaining !== undefined
              ? `待分析 ${status.remaining} 张`
              : '正在核对截图'}
          </p>
          {progressPercent !== null &&
            status &&
            status.total !== null &&
            status.analyzed !== null && (
              <div className="backfill-progress">
                <div className="backfill-progress-label">
                  <span>分析进度</span>
                  <strong>{progressPercent}%</strong>
                </div>
                <progress
                  aria-label="截图分析进度"
                  aria-valuetext={`已分析 ${status.analyzed} / ${status.total} 张，${progressPercent}%`}
                  max={status.total}
                  value={status.analyzed}
                />
              </div>
            )}
          <div className="pipeline-state" role="status">
            <h4>
              {error || (status ? labels[status.state] : '正在核对截图…')}
            </h4>
          </div>
        </section>
        <div
          className={`pipeline-transfer${sameDay ? '' : ' independent'}`}
          data-revision={transfers.association}
          aria-hidden="true"
        >
          {active &&
            sameDay &&
            associationAvailable &&
            transfers.association > 0 && (
              <PipelinePacket key={transfers.association} />
            )}
        </div>
        <aside
          className="backfill-stage association-panel"
          aria-label="任务关联进度"
        >
          <div className="pipeline-node">
            <Network aria-hidden="true" />
          </div>
          <h3>任务关联</h3>
          <p className="pipeline-value association-count">
            <span>待关联 </span>
            {taskReply ? taskReply.pendingCount : '—'}
            <span> 条</span>
          </p>
          <p className="pipeline-detail">查看日期 {taskDay}</p>
          <p className="association-state pipeline-state">
            <span
              className={`status-ball${organizingNow ? ' running' : ''}`}
              role="status"
            >
              <i />
              {associationLabel(association, taskReply)}
            </span>
          </p>
          {associationIssue && (
            <p className="muted association-issue">{associationIssue}</p>
          )}
        </aside>
      </div>
      <div className="backfill-action-row">
        <div className="backfill-action-copy">
          {status && <p id="backfill-action-help">{status.message}</p>}
          {running && status && status.planned > 0 && (
            <p>
              本轮已保存 {status.processed} / {status.planned} 张
            </p>
          )}
          {otherDay && <p>正在补分析 {status.activeDay}，请等待该任务结束。</p>}
          {status && !status.eligible && status.state !== 'error' && (
            <p>补分析支持今天和历史日期，请选择今天或更早日期。</p>
          )}
        </div>
        <button
          className="backfill-button"
          disabled={disabled}
          aria-busy={busy}
          aria-describedby={status ? 'backfill-action-help' : undefined}
          onClick={action}
        >
          {buttonLabel}
        </button>
      </div>
      {active && <ScreenshotDirectory directory={bridge.screenshotDirectory} />}
      <div className="backfill-notes">
        <p className="muted backfill-note">
          分析结果保存到截图原日期，切换页面后会继续处理。
        </p>
        <p className="muted association-note">
          {taskReply?.organizing === 'disabled'
            ? '任务关联已停用，补分析可独立进行。'
            : sameDay
              ? '每批分析保存后进入关联，两项任务按各自进度推进。'
              : `任务关联跟随时间线日期 ${taskDay}，两项任务独立进行。`}
        </p>
      </div>
    </section>
  );
}
