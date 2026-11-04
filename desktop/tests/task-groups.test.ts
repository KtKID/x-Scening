import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskTimeline } from '../src/renderer/src/TaskTimeline';
import { DayTaskViewSchema } from '../src/shared/scening.generated';
import { SnapshotSchema } from '../src/shared/protocol';
const day = '2026-11-01';
const rows = [
  ['11:58:43', '11:59:15', '观看国际时政评论视频'],
  ['11:59:43', '12:03:43', '观看波士顿圆脸口播视频'],
  ['12:03:44', '12:08:43', '继续播放解读类评论视频'],
];
const segments = rows.map(([start, end, action], i) => ({
  segmentId: `s${String(i)}`,
  taskId: 'watch',
  activityIds: [`r${String(i)}`],
  start: `${day}T${start ?? ''}+08:00`,
  end: `${day}T${end ?? ''}+08:00`,
  action: action ?? '',
  estimateSeconds: 0,
  partial: true,
  sliceIds: [],
  pointIds: [],
}));
const view = DayTaskViewSchema.parse({
  day,
  tasks: ['watch', 'other', 'same-title'].map((taskId) => ({
    taskId,
    day,
    title: taskId === 'other' ? '收集开发资料' : '观看B站解读视频',
    object: taskId,
    goal: taskId,
  })),
  segments,
  progress: [],
  slices: [],
  points: [],
  totals: [],
  issues: [],
  start: segments[0]?.start,
  end: segments[2]?.end,
  coveredUntil: segments[2]?.end,
});
const snapshot = SnapshotSchema.parse({
  day,
  source: 'local',
  sourceRevision: '',
  issues: [],
  summaries: [],
  locations: { configPath: '', home: '', screenshotDir: '' },
  activities: segments.map((s, i) => ({
    id: s.activityIds[0],
    title: s.action,
    analysis: s.action,
    app: i === 1 ? 'Notes' : 'Chrome',
    start: s.start,
    end: s.end,
    screenshot: 'a.jpg',
    mini: 'a.jpg',
  })),
});
function render(next = view, filter = 'all', gap: number | null = 90) {
  return renderToStaticMarkup(
    createElement(TaskTimeline, {
      view: next,
      activities: snapshot.activities,
      filter,
      selected: null,
      pending: null,
      onSelect: () => {},
      onLocated: () => {},
      maxGapSeconds: gap,
    }),
  );
}
await test('截图里的三个同任务记录：时长待确认也形成一组，保留三个活动子卡', () => {
  const text = render();
  assert.equal((text.match(/data-testid="task-group"/g) ?? []).length, 1);
  assert.equal((text.match(/data-testid="activity-card"/g) ?? []).length, 3);
  for (const row of rows) assert.ok(text.includes(row[2] ?? ''));
  assert.ok(text.includes('11:58'));
  assert.ok(text.includes('12:08'));
  assert.ok(text.includes('时长待确认'));
});
await test('多任务保持普通卡和可点击标签，整条活动正文保留', () => {
  const first = view.segments[0];
  assert.ok(first);
  const multiple = {
    ...view,
    segments: [first, { ...first, segmentId: 'second-task', taskId: 'other' }],
  };
  const text = render(multiple);
  assert.equal((text.match(/data-testid="task-group"/g) ?? []).length, 0);
  assert.equal((text.match(/data-testid="activity-card"/g) ?? []).length, 1);
  assert.ok(text.includes('task-link-tag'));
  assert.ok(!text.includes('task-branches'));
  assert.ok(text.includes('观看B站解读视频'));
  assert.ok(text.includes('收集开发资料'));
  assert.ok(text.includes(first.action));
});
await test('A B A 的切换保留三张卡；筛选隐藏B也保留两个A的位置', () => {
  const changed = {
    ...view,
    segments: view.segments.map((s, i) => ({
      ...s,
      taskId: i === 1 ? 'other' : 'watch',
    })),
  };
  for (const filter of ['all', 'Chrome']) {
    const text = render(changed, filter);
    assert.equal((text.match(/data-testid="task-group"/g) ?? []).length, 0);
  }
});
await test('同名不同任务ID和待关联记录分别形成边界', () => {
  for (const taskId of ['same-title', null]) {
    const changed = {
      ...view,
      segments: view.segments.map((s, i) => ({
        ...s,
        taskId: i === 1 ? taskId : 'watch',
      })),
    };
    assert.equal(
      (render(changed).match(/data-testid="task-group"/g) ?? []).length,
      0,
    );
  }
});
await test('多任务记录处于中间时，两侧单任务各自保留', () => {
  const middle = view.segments[1];
  assert.ok(middle);
  const next = {
    ...view,
    segments: [
      ...view.segments,
      { ...middle, taskId: 'other', segmentId: 'also-other' },
    ],
  };
  assert.equal(
    (render(next).match(/data-testid="task-group"/g) ?? []).length,
    0,
  );
});
await test('长间隔与配置读取失败保留独立卡，间隔取传入权威值', () => {
  for (const gap of [null, 0])
    assert.equal(
      (render(view, 'all', gap).match(/data-testid="task-group"/g) ?? [])
        .length,
      0,
    );
  const last = view.segments[2];
  assert.ok(last);
  const changed = {
    ...view,
    segments: [
      view.segments[0],
      { ...last, start: `${day}T14:00:00+08:00`, end: `${day}T14:01:00+08:00` },
    ],
  };
  const parsed = DayTaskViewSchema.parse(changed);
  assert.equal(
    (render(parsed).match(/data-testid="task-group"/g) ?? []).length,
    0,
  );
});
