import type { z } from 'zod';
import type { SegmentSchema } from './scening.generated';

type Segment = z.infer<typeof SegmentSchema>;

/** 点击时间位置直接选中片段；实际覆盖优先，短片段取12px内最近目标，同位置按绘制顺序选上层。 */
export function timebarTarget(
  segments: Segment[],
  start: string | null,
  end: string | null,
  x: number,
  width: number,
): Segment | null {
  const first = Date.parse(start ?? '');
  const last = Date.parse(end ?? '');
  const span = last - first;
  if (!Number.isFinite(span) || span < 0 || !Number.isFinite(x) || width <= 0)
    return null;
  let target: Segment | null = null;
  let nearest = 12;
  for (const segment of segments) {
    const from = Date.parse(segment.start);
    const to = Date.parse(segment.end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    const left = span > 0 ? ((from - first) / span) * width : width / 2;
    const right = span > 0 ? ((to - first) / span) * width : width / 2;
    const distance = Math.max(left - x, x - right, 0);
    if (distance <= nearest) {
      target = segment;
      nearest = distance;
    }
  }
  return target;
}
