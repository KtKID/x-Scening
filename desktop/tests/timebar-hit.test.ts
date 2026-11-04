import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentSchema } from '../src/shared/scening.generated';
import { timebarTarget } from '../src/shared/timebar-hit';

const day = '2026-10-30';
const at = (time: string) => `${day}T${time}+08:00`;
const start = at('09:00:00');
const end = at('18:00:00');
function segment(
  id: string,
  from: string,
  to: string,
  taskId: string | null = id,
) {
  return SegmentSchema.parse({
    segmentId: id,
    taskId,
    activityIds: [id],
    start: at(from),
    end: at(to),
    action: id,
    estimateSeconds: 0,
    partial: true,
    sliceIds: [],
    pointIds: [],
  });
}
await test('时间条：实际时间块优先于旁边短块的扩大命中范围', () => {
  const a = segment('a', '09:00:00', '09:01:00');
  const b = segment('b', '09:01:05', '09:02:05');
  assert.equal(timebarTarget([a, b], start, end, 55 / 60, 540)?.segmentId, 'a');
});
await test('时间条：密集点选最近一条，待关联点也返回明确目标', () => {
  const a = segment('a', '09:00:00', '09:00:00');
  const b = segment('b', '09:00:30', '09:00:30', null);
  assert.equal(timebarTarget([a, b], start, end, 20 / 60, 540)?.segmentId, 'b');
  assert.equal(timebarTarget([a, b], start, end, 20 / 60, 540)?.taskId, null);
});
await test('时间条：真实空白返回范围说明，边缘短点可直接点击', () => {
  const point = segment('last', '18:00:00', '18:00:00', null);
  assert.equal(
    timebarTarget([point], start, end, 539.9, 540)?.segmentId,
    'last',
  );
  assert.equal(timebarTarget([point], start, end, 300, 540), null);
});
await test('时间条：重叠观察与显示顺序一致，零跨度观察位于中央', () => {
  const a = segment('a', '09:00:00', '09:01:00');
  const b = segment('b', '09:00:00', '09:01:00');
  assert.equal(timebarTarget([a, b], start, end, 0.5, 540)?.segmentId, 'b');
  const point = segment('point', '09:00:00', '09:00:00');
  assert.equal(
    timebarTarget([point], start, start, 270, 540)?.segmentId,
    'point',
  );
  assert.equal(timebarTarget([point], start, start, 0, 540), null);
  assert.equal(timebarTarget([point], start, start, 0, 0), null);
});
