import { clock } from './protocol';
import type { TimelineActivity } from './protocol';

/** 应用名来自逐帧系统采集；旧单图沿用app，缺项显示未知应用。 */
export function capturedApplicationNames(
  activity: Pick<TimelineActivity, 'app' | 'frames'>,
): string[] {
  const values = activity.frames?.length
    ? activity.frames.map((frame) => frame.app)
    : [activity.app];
  return [...new Set(values.map((value) => value?.trim() || '未知应用'))];
}

export function capturedApplicationLabel(
  activity: Pick<TimelineActivity, 'app' | 'frames'>,
): string {
  return capturedApplicationNames(activity).join('、');
}

/** 每条活动在涉及的各应用中分别计一次，重复帧按同一应用去重。 */
export function applicationCounts(
  activities: readonly TimelineActivity[],
): [string, number][] {
  const counts = new Map<string, number>();
  for (const activity of activities)
    for (const name of capturedApplicationNames(activity))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** 仅整理展示文本；完整的analysis由原记录继续持有。 */
export function cardPreview(analysis: string): string {
  const facts =
    analysis.match(/(?:\*\*)?可见事实(?:\*\*)?\s*[：:]\s*([\s\S]*)/)?.[1] ??
    analysis;
  const paragraph =
    facts
      .trim()
      .split(
        /\n\s*\n|\n\s*(?:\*\*)?(?:推测|观察到的变化|完成状态证据)(?:\*\*)?\s*[：:]/,
        1,
      )[0] ?? facts;
  return paragraph
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cardTitle(analysis: string): string {
  const preview = cardPreview(analysis);
  return preview.split(/[，,。；;\n]/, 1)[0]?.trim() || preview || analysis;
}

/** 单次观察保留原秒级时间；短区间显示秒，长区间沿用分钟刻度。 */
export function activityTime(
  activity: Pick<TimelineActivity, 'start' | 'end'>,
): string {
  if (Date.parse(activity.start) === Date.parse(activity.end))
    return `${activity.start.slice(11, 19)} · 单次观察`;
  if (clock(activity.start) === clock(activity.end))
    return `${activity.start.slice(11, 19)} — ${activity.end.slice(11, 19)}`;
  return `${clock(activity.start)} — ${clock(activity.end)}`;
}
