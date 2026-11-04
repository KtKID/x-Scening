import type { TimelineActivity } from '../../shared/protocol';
import { TaskTypeLabels } from './TaskTypeLabels';
import { X } from 'lucide-react';
import type { View, Segment } from './TaskTimeline';
import { DayTimebar } from './DayTimebar';
import { clock } from '../../shared/protocol';
import { taskAccent, investmentLabel } from '../../shared/task-presentation';
export function TaskDetails({
  view,
  segment,
  activities,
  onClose,
  onNavigate,
  onImage,
}: {
  view: View;
  segment: Segment;
  activities: readonly TimelineActivity[];
  onClose: () => void;
  onNavigate: (id: string) => void;
  onImage: (id: string, frameIndex?: number) => void;
}) {
  const task = view.tasks.find((t) => t.taskId === segment.taskId);
  if (!task) return null;
  const total = view.totals.find((t) => t.taskId === task.taskId);
  const own = view.segments.filter((s) => s.taskId === task.taskId);
  const progress = view.progress.filter((p) => p.taskId === task.taskId);
  return (
    <div className="task-details">
      <div className="inspector-heading">
        <h2>任务详情</h2>
        <button
          className="icon-button"
          aria-label="关闭任务详情"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <p className="eyebrow">{view.day} · 当天任务</p>
      <h3 style={{ color: taskAccent(task.taskId) }}>{task.title}</h3>
      <p>
        {investmentLabel(
          total?.estimatedSeconds ?? 0,
          total?.hasUncertainCoverage ?? true,
        )}{' '}
        · 关联 {new Set(own.flatMap((item) => item.activityIds)).size} 条记录
      </p>
      <TaskTypeLabels
        activities={activities.filter((activity) =>
          own.some((item) => item.activityIds.includes(activity.id)),
        )}
      />
      <DayTimebar view={view} taskId={task.taskId} onSegment={onNavigate} />
      <h4>当天进展</h4>
      {progress.length === 0 ? (
        <p className="muted">阶段变化待确认。下面保留已记录的活动。</p>
      ) : (
        progress.map((p) => (
          <article className="task-progress" key={p.progressId}>
            <p>{p.text}</p>
            <small>
              {
                {
                  observed: '观察到的活动与变化',
                  ai_reported: 'AI 报告，结果待核对',
                  inferred: '根据记录推测',
                  unknown: '待确认',
                }[p.kind]
              }
            </small>
            {p.evidence.map((e) => {
              const s = own.find((item) =>
                item.activityIds.includes(e.activityId),
              );
              return (
                <div key={`${e.activityId}:${e.excerpt}`}>
                  <blockquote>{e.excerpt}</blockquote>
                  <div className="evidence-images">
                    {e.frameIndexes?.length ? (
                      e.frameIndexes.map((index) => (
                        <button
                          type="button"
                          className="text-button"
                          key={index}
                          onClick={() => onImage(e.activityId, index)}
                        >
                          查看图{index}
                        </button>
                      ))
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onImage(e.activityId)}
                      >
                        查看截图（具体帧待确认）
                      </button>
                    )}
                  </div>
                  {s && (
                    <button
                      className="text-button"
                      onClick={() => onNavigate(s.segmentId)}
                    >
                      回看 {clock(s.start)} 的记录
                    </button>
                  )}
                </div>
              );
            })}
          </article>
        ))
      )}
      <h4>各次投入</h4>
      {own.map((s) => (
        <div className="task-investment" key={s.segmentId}>
          <button
            className={`investment-link ${s.segmentId === segment.segmentId ? 'active' : ''}`}
            onClick={() => onNavigate(s.segmentId)}
          >
            {clock(s.start)} — {clock(s.end)}
            <span>{investmentLabel(s.estimateSeconds, s.partial)}</span>
          </button>
          <p>{s.action}</p>
          {s.activityIds.map((id) => (
            <button
              key={id}
              className="text-button"
              onClick={() => onImage(id)}
            >
              查看原观察与截图
            </button>
          ))}
        </div>
      ))}
      <p className="muted">
        进展截至 {view.coveredUntil ? clock(view.coveredUntil) : '待关联'} ·
        活动与变化按来源记录
      </p>
    </div>
  );
}
