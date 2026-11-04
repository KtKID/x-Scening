import type { z } from 'zod';
import type { SegmentSchema } from './scening.generated';

/** 固定色板是展示约定，同一任务在所有入口共用颜色。 */
const palette = [
  '#63856b',
  '#b18b40',
  '#7e8aa9',
  '#a78970',
  '#8e9271',
  '#9b798a',
  '#648b93',
  '#a9795e',
];
export function taskAccent(taskId: string | null): string {
  if (taskId === null) return '#98988d';
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(taskId)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return palette[(hash >>> 0) % palette.length] ?? '#63856b';
}
export function investmentLabel(seconds: number, partial: boolean): string {
  if (seconds <= 0) return '时长待确认';
  const label = `约 ${String(Math.max(1, Math.round(seconds / 60)))} 分钟`;
  return partial ? `${label} · 部分时段待确认` : label;
}

/** 同一原记录和时间位置的任务分支共用一张卡及一个观察范围。 */
export function groupTaskSegments(
  segments: readonly z.infer<typeof SegmentSchema>[],
) {
  const groups = new Map<string, z.infer<typeof SegmentSchema>[]>();
  for (const segment of segments) {
    const key = JSON.stringify([
      segment.start,
      segment.end,
      [...segment.activityIds].sort(),
    ]);
    const members = groups.get(key) ?? [];
    members.push(segment);
    groups.set(key, members);
  }
  return [...groups].map(([key, members]) => ({ key, members }));
}

/** 展示分组只引用原片段：相邻、同一单任务且在配置衔接间隔内的卡片形成一组。
 * 先处理完整序列，再由界面筛选成员，任务切换和多任务记录始终保留边界。
 * 这里仅建立可读层次，时长、进展与原始来源继续使用既有投影。
 */
export function groupSingleTaskActivities(
  segments: readonly z.infer<typeof SegmentSchema>[],
  maxGapSeconds: number | null,
) {
  const records = groupTaskSegments(segments).sort(
    (a, b) =>
      Date.parse(a.members[0]?.start ?? '') -
      Date.parse(b.members[0]?.start ?? ''),
  );
  const groups: {
    key: string;
    taskId: string | null;
    records: typeof records;
  }[] = [];
  for (const record of records) {
    const first = record.members[0];
    if (!first) continue;
    const taskId = record.members.length === 1 ? first.taskId : null;
    const previous = groups.at(-1);
    const last = previous?.records.at(-1)?.members[0];
    const gap = last
      ? (Date.parse(first.start) - Date.parse(last.end)) / 1000
      : Infinity;
    if (
      taskId &&
      previous?.taskId === taskId &&
      last &&
      maxGapSeconds !== null &&
      Number.isFinite(gap) &&
      gap <= maxGapSeconds &&
      first.start.slice(0, 10) === last.start.slice(0, 10)
    ) {
      previous.records.push(record);
    } else groups.push({ key: record.key, taskId, records: [record] });
  }
  return groups;
}
