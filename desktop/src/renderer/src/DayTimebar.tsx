import { useState } from 'react';
import type { View, Segment } from './TaskTimeline';
import {
  taskAccent,
  investmentLabel,
  groupTaskSegments,
} from '../../shared/task-presentation';
import { clock } from '../../shared/protocol';
import { timebarTarget } from '../../shared/timebar-hit';

type Selection =
  | { kind: 'segments'; ids: string[] }
  | { kind: 'range'; sliceId: string }
  | null;

export function DayTimebar({
  view,
  taskId,
  onSegment,
}: {
  view: View;
  taskId: string;
  onSegment: (id: string) => void;
}) {
  const [selection, setSelection] = useState<Selection>(null);
  const start = Date.parse(view.start ?? '');
  const end = Date.parse(view.end ?? '');
  const span = end - start;
  const proportion = (value: string) =>
    span > 0
      ? Math.max(0, Math.min(100, ((Date.parse(value) - start) / span) * 100))
      : 50;
  const segments = view.segments.filter(
    (s) =>
      Number.isFinite(Date.parse(s.start)) &&
      Number.isFinite(Date.parse(s.end)),
  );
  const observationGroups = groupTaskSegments(segments);
  const selected =
    selection?.kind === 'segments'
      ? segments.filter((s) => selection.ids.includes(s.segmentId))
      : [];
  const range =
    selection?.kind === 'range'
      ? view.slices.find((s) => s.sliceId === selection.sliceId)
      : null;
  const taskName = (s: Segment) =>
    view.tasks.find((t) => t.taskId === s.taskId)?.title ?? '任务待关联';
  const segmentLabel = (s: Segment) =>
    `${clock(s.start)} — ${clock(s.end)} · ${taskName(s)} · ${investmentLabel(s.estimateSeconds, s.partial)}`;
  const navigate = (s: Segment) => {
    setSelection(null);
    onSegment(s.segmentId);
  };
  return (
    <section className="day-timebar" aria-label="全天时间分布">
      <div className="timebar-heading">
        <span className="eyebrow">这一天里的投入</span>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setSelection({
              kind: 'segments',
              ids: segments.map((s) => s.segmentId),
            })
          }
        >
          按时间选择
        </button>
      </div>
      <button
        type="button"
        className="timebar-track"
        aria-label="全天时间条，点击时间段回看任务"
        title="点击时间块直接定位卡片；很窄的片段定位最近记录，斜纹表示时长待确认"
        onClick={(event) => {
          if (event.detail === 0) {
            setSelection({
              kind: 'segments',
              ids: segments.map((s) => s.segmentId),
            });
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          const width = event.currentTarget.clientWidth;
          const x = Math.max(
            0,
            Math.min(
              width,
              event.clientX - bounds.left - event.currentTarget.clientLeft,
            ),
          );
          const target = timebarTarget(
            segments,
            view.start,
            view.end,
            x,
            width,
          );
          if (target) {
            const group = observationGroups.find((item) =>
              item.members.some((s) => s.segmentId === target.segmentId),
            );
            const at = start + (span > 0 ? (x / width) * span : 0);
            const owner = view.slices.find(
              (s) =>
                s.kind === 'task' &&
                at >= Date.parse(s.start) &&
                at < Date.parse(s.end),
            )?.taskId;
            const preferred =
              group?.members.find((s) => s.taskId === owner) ??
              group?.members.find((s) => s.taskId === taskId);
            if (preferred) navigate(preferred);
            else if (group && group.members.length > 1)
              setSelection({
                kind: 'segments',
                ids: group.members.map((s) => s.segmentId),
              });
            else navigate(target);
          } else {
            const at = start + (span > 0 ? (x / width) * span : 0);
            const slice = view.slices.find(
              (s) => at >= Date.parse(s.start) && at <= Date.parse(s.end),
            );
            if (slice) setSelection({ kind: 'range', sliceId: slice.sliceId });
          }
        }}
      >
        {view.slices.map((slice) => (
          <span
            aria-hidden="true"
            key={slice.sliceId}
            className={`timebar-slice ${slice.kind}`}
            style={{
              left: `${String(proportion(slice.start))}%`,
              width: `${String(proportion(slice.end) - proportion(slice.start))}%`,
              backgroundColor:
                slice.kind === 'task' ? taskAccent(slice.taskId) : undefined,
            }}
          />
        ))}
        {observationGroups.map(({ key, members }) => {
          const s = members[0];
          if (!s) return null;
          const multiple = members.length > 1;
          return (
            <span
              aria-hidden="true"
              key={key}
              className={`timebar-observation ${multiple ? 'multiple' : s.taskId ? 'task' : 'unassigned'} ${s.partial ? 'partial' : ''} ${members.some((item) => item.taskId === taskId) ? 'active' : ''}`}
              style={{
                left: `min(${String(proportion(s.start))}%, calc(100% - 2px))`,
                width: `${String(proportion(s.end) - proportion(s.start))}%`,
                backgroundColor: multiple
                  ? 'transparent'
                  : taskAccent(s.taskId),
                opacity: multiple || s.taskId === taskId ? 1 : 0.6,
              }}
            />
          );
        })}
      </button>
      <div className="timebar-ticks">
        <span>{view.start ? clock(view.start) : ''}</span>
        {span > 0 && (
          <span>
            {new Date(start + span / 2).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </span>
        )}
        <span>{view.end ? clock(view.end) : ''}</span>
      </div>
      <p className="muted">
        彩色为任务观察范围 · 虚线为多任务记录 · 斜纹时长待确认 · 点击回看
      </p>
      {selection && (
        <div className="timebar-selection" role="status">
          {range && (
            <p>
              <strong>
                {clock(range.start)} — {clock(range.end)}
              </strong>
              <br />
              {range.reason ?? '时间待确认'}
              。该范围的活动与投入时长以可查看记录为准。
            </p>
          )}
          {selected.length > 0 && (
            <>
              <p>
                {selected.length > 1
                  ? '这个位置有多条记录，选择一条回看：'
                  : '任务待关联，保留当前任务详情，可定位观察记录：'}
              </p>
              <div className="timebar-options">
                {selected.map((s) => (
                  <button
                    type="button"
                    key={s.segmentId}
                    aria-label={
                      s.taskId
                        ? segmentLabel(s)
                        : `定位这条待关联记录：${clock(s.start)} · ${s.action}`
                    }
                    onClick={() => navigate(s)}
                  >
                    <span
                      className="timebar-option-dot"
                      style={{ backgroundColor: taskAccent(s.taskId) }}
                    />
                    <span>
                      {segmentLabel(s)}
                      <small>{s.action}</small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => setSelection(null)}
          >
            收起时间段说明
          </button>
        </div>
      )}
    </section>
  );
}
