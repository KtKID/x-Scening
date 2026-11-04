import type { TimelineActivity } from '../../shared/protocol';

/** 原始活动与任务片段共用已保存类型；跨活动合并保持首次出现顺序。 */
export function TaskTypeLabels({
  activities,
}: {
  activities: readonly TimelineActivity[];
}) {
  const labels = [
    ...new Set(
      activities.flatMap((activity) => activity.observation?.task_types ?? []),
    ),
  ];
  return (
    <div className="task-type-labels" role="list" aria-label="任务类型">
      {(labels.length ? labels : ['待分类']).map((label) => (
        <span
          role="listitem"
          className={`task-type-label${labels.length ? '' : ' pending'}`}
          key={label}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
