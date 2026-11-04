import { useEffect, useLayoutEffect, useRef } from 'react';
import type { z } from 'zod';
import type {
  DayTaskViewSchema,
  SegmentSchema,
} from '../../shared/scening.generated';
import type { TimelineActivity } from '../../shared/protocol';
import { clock } from '../../shared/protocol';
import { capturedApplicationNames } from '../../shared/presentation';
import {
  taskAccent,
  investmentLabel,
  groupSingleTaskActivities,
} from '../../shared/task-presentation';
import { TaskTypeLabels } from './TaskTypeLabels';
export type View = z.infer<typeof DayTaskViewSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export function TaskTimeline({
  view,
  activities,
  filter,
  selected,
  onSelect,
  pending,
  onLocated,
  onImage,
  maxGapSeconds = null,
}: {
  view: View;
  activities: TimelineActivity[];
  filter: string;
  selected: string | null;
  onSelect: (id: string) => void;
  pending: string | null;
  onLocated: () => void;
  onImage?: (id: string) => void;
  maxGapSeconds?: number | null;
}) {
  const container = useRef<HTMLElement>(null);
  const anchor = useRef<{ id: string; offset: number; filter: string } | null>(
    null,
  );
  useEffect(() => {
    const root = container.current?.closest('.workspace-body');
    if (!(root instanceof HTMLElement)) return;
    const remember = () => {
      const top = root.getBoundingClientRect().top;
      const first = Array.from(
        container.current?.querySelectorAll<HTMLElement>('[data-segment-id]') ??
          [],
      ).find((node) => node.getBoundingClientRect().bottom > top);
      if (first?.dataset.segmentId)
        anchor.current = {
          id: first.dataset.segmentId,
          offset: first.getBoundingClientRect().top - top,
          filter,
        };
    };
    root.addEventListener('scroll', remember);
    return () => root.removeEventListener('scroll', remember);
  }, [filter]);
  useLayoutEffect(() => {
    if (pending || anchor.current?.filter !== filter) return;
    const root = container.current?.closest('.workspace-body');
    const saved = anchor.current;
    const target = Array.from(
      container.current?.querySelectorAll<HTMLElement>('[data-segment-id]') ??
        [],
    ).find((node) => node.dataset.segmentId === saved?.id);
    if (root instanceof HTMLElement && target && saved)
      root.scrollTop +=
        target.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        saved.offset;
  }, [view, filter, pending, maxGapSeconds]);
  const selectedTask = view.segments.find(
    (s) => s.segmentId === selected,
  )?.taskId;
  const visible = view.segments.filter(
    (s) =>
      filter === 'all' ||
      s.activityIds.some((id) =>
        activities.some(
          (a) => a.id === id && capturedApplicationNames(a).includes(filter),
        ),
      ),
  );
  useLayoutEffect(() => {
    if (!pending) return;
    const target = Array.from(
      container.current?.querySelectorAll<HTMLElement>('[data-segment-id]') ??
        [],
    ).find((node) => node.dataset.segmentId === pending);
    if (target) {
      const root = container.current?.closest('.workspace-body');
      if (root instanceof HTMLElement) {
        root.scrollTop +=
          target.getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          16;
        // 主动回看完成后立即保存新锚点，后续刷新沿用目标位置。
        anchor.current = {
          id: pending,
          offset:
            target.getBoundingClientRect().top -
            root.getBoundingClientRect().top,
          filter,
        };
      }
      target.focus({ preventScroll: true });
      onLocated();
    }
  }, [pending, visible, filter, onLocated]);
  // 分组先于筛选，避免隐藏的任务切换把两侧同任务误接起来。
  const groups = groupSingleTaskActivities(view.segments, maxGapSeconds);
  const visibleIds = new Set(visible.map((s) => s.segmentId));
  const renderRecord = (
    record: (typeof groups)[number]['records'][number],
    nested = false,
  ) => {
    const { key, members } = record;
    const segment = members[0];
    if (!segment) return null;
    const multiple = members.length > 1;
    const task = view.tasks.find((t) => t.taskId === segment.taskId);
    const related = members.some(
      (s) => selectedTask && s.taskId === selectedTask,
    );
    const recordActivities = activities.filter((a) =>
      segment.activityIds.includes(a.id),
    );
    const apps = [
      ...new Set(recordActivities.flatMap(capturedApplicationNames)),
    ];
    const body = (
      <>
        <div className="task-segment-meta task-segment-header">
          <div className="task-segment-context">
            <span className="task-segment-time">
              {clock(segment.start)} — {clock(segment.end)}
            </span>
            <span className="task-segment-task">
              关联任务：
              {multiple ? (
                <span className="task-link-tags">
                  {members.map((branch) => (
                    <button
                      type="button"
                      key={branch.segmentId}
                      className={`task-link-tag ${selected === branch.segmentId ? 'selected-task-tag' : ''}`}
                      data-segment-id={branch.segmentId}
                      aria-pressed={selected === branch.segmentId}
                      onClick={() => onSelect(branch.segmentId)}
                      style={{ color: taskAccent(branch.taskId) }}
                    >
                      {view.tasks.find((t) => t.taskId === branch.taskId)
                        ?.title ?? '待关联'}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="task-link-label">
                  {task?.title ?? '待关联'}
                </span>
              )}
            </span>
          </div>
          <TaskTypeLabels activities={recordActivities} />
        </div>
        {!nested && (
          <h3>
            {multiple
              ? (recordActivities[0]?.title ?? '本次活动')
              : (task?.title ?? '待关联活动')}
          </h3>
        )}
        <p>
          {multiple
            ? recordActivities
                .map((a) => a.observation?.visible_activity ?? a.analysis)
                .join('\n') || segment.action
            : segment.action}
        </p>
        <span className="task-segment-meta">
          <span>{apps.join(' · ')}</span>
          <span>
            {multiple
              ? '时长待确认'
              : investmentLabel(segment.estimateSeconds, segment.partial)}
          </span>
        </span>
      </>
    );
    const className = `task-segment ${multiple ? 'multi-task-card' : ''} ${related ? 'related' : ''} ${nested ? 'task-group-child' : ''}`;
    if (multiple) {
      const originalId = segment.activityIds[0];
      return (
        <article
          key={key}
          className={className}
          data-testid="activity-card"
          aria-label="关联多个任务的活动记录"
          style={{ borderLeftColor: taskAccent(null) }}
        >
          {body}
          {onImage && originalId && (
            <button
              type="button"
              className="text-button original-record-link"
              onClick={() => onImage(originalId)}
            >
              查看原观察与截图
            </button>
          )}
        </article>
      );
    }
    return (
      <button
        key={key}
        className={className}
        style={{ borderLeftColor: taskAccent(segment.taskId) }}
        data-testid="activity-card"
        data-segment-id={segment.segmentId}
        aria-pressed={selected === segment.segmentId}
        onClick={() => onSelect(segment.segmentId)}
      >
        {body}
      </button>
    );
  };
  return (
    <section className="task-timeline" ref={container} aria-label="事情时间线">
      <div className="eyebrow">TODAY'S JOURNEY</div>
      <h2>今天推进的事情</h2>
      {visible.length === 0 && <p>当前筛选暂无活动</p>}
      {groups.map((group) => {
        const records = group.records.filter((record) =>
          record.members.some((s) => visibleIds.has(s.segmentId)),
        );
        if (records.length === 0) return null;
        if (records.length === 1) {
          const only = records[0];
          return only ? renderRecord(only) : null;
        }
        const first = records[0]?.members[0];
        const last = records
          .flatMap((r) => r.members)
          .reduce<Segment | undefined>(
            (latest, item) =>
              !latest || Date.parse(item.end) > Date.parse(latest.end)
                ? item
                : latest,
            undefined,
          );
        if (!first || !last) return null;
        const task = view.tasks.find((t) => t.taskId === group.taskId);
        return (
          <article
            key={group.key}
            className="task-group"
            data-testid="task-group"
            aria-label={`${task?.title ?? '关联任务'}的活动组`}
            style={{ borderLeftColor: taskAccent(group.taskId) }}
          >
            <div className="task-group-heading">
              <h3>{task?.title ?? '关联任务'}</h3>
              <span>
                观察范围 {clock(first.start)} — {clock(last.end)} ·{' '}
                {records.length}段活动
              </span>
            </div>
            <div className="task-group-activities">
              {records.map((record) => renderRecord(record, true))}
            </div>
          </article>
        );
      })}
    </section>
  );
}
