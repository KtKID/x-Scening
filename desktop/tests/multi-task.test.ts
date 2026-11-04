import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskTimeline } from '../src/renderer/src/TaskTimeline';
import { TaskDetails } from '../src/renderer/src/TaskDetails';
import { SnapshotSchema } from '../src/shared/protocol';
import {
  DayTaskViewSchema,
  DailyReviewSchema,
  TimelineReadReplySchema,
} from '../src/shared/scening.generated';
import { buildDailyArchive } from '../src/shared/daily-archive';
const day = '2026-11-01';
const start = `${day}T09:00:00+08:00`;
const end = `${day}T09:03:00+08:00`;
const snapshot = SnapshotSchema.parse({
  day,
  source: 'local',
  sourceRevision: 'source',
  issues: [],
  summaries: [],
  locations: { configPath: '', home: '', screenshotDir: '' },
  activities: [
    {
      id: 'record',
      title: '三帧观察',
      app: '无线麦',
      start,
      end,
      analysis: '麦克风与博客活动',
      screenshot: 'batch.jpg',
      mini: 'batch.jpg',
      frames: ['无线麦', 'Editor'].map((app) => ({
        app,
        capturedAt: start,
        screenshot: 'a.jpg',
      })),
      observation: {
        schema_version: 1,
        visible_activity: '综合记录',
        inferred_intent: '验证多任务',
        stage_and_evidence: '有原文依据',
        app_tags: [],
        task_types: ['工作', '学习'],
      },
    },
  ],
});
const view = DayTaskViewSchema.parse({
  day,
  tasks: [
    {
      taskId: 'mic',
      day,
      title: '配置麦克风按键',
      object: '麦克风',
      goal: '配置',
    },
    {
      taskId: 'blog',
      day,
      title: '修改博客内容',
      object: '博客',
      goal: '修改',
    },
  ],
  segments: ['mic', 'blog'].map((taskId) => ({
    segmentId: taskId,
    taskId,
    activityIds: ['record'],
    start,
    end,
    action: taskId === 'mic' ? '调整按键映射' : '修改文章段落',
    estimateSeconds: 0,
    partial: true,
    sliceIds: [],
    pointIds: [],
  })),
  progress: ['mic', 'blog'].map((taskId) => ({
    progressId: taskId,
    taskId,
    text: taskId === 'mic' ? '麦克风进展' : '博客进展',
    kind: 'observed',
    evidence: [
      {
        activityId: 'record',
        sourceSignature: 'signature',
        excerpt: taskId === 'mic' ? '麦克风原文' : '博客原文',
        frameIndexes: taskId === 'mic' ? [1] : [],
      },
    ],
  })),
  slices: [],
  points: [],
  totals: [],
  issues: [],
  start,
  end,
  coveredUntil: end,
});
await test('多任务记录：一张普通卡包含两个任务标签及一组分类', () => {
  const text = renderToStaticMarkup(
    createElement(TaskTimeline, {
      view,
      activities: snapshot.activities,
      filter: 'all',
      selected: null,
      pending: null,
      onSelect: () => {},
      onLocated: () => {},
    }),
  );
  assert.equal((text.match(/data-testid="activity-card"/g) ?? []).length, 1);
  assert.ok(text.includes('配置麦克风按键'));
  assert.ok(text.includes('修改博客内容'));
  assert.equal((text.match(/aria-label="任务类型"/g) ?? []).length, 1);
  assert.ok(!text.includes('task-branches'));
  assert.equal((text.match(/class="task-link-tag(?: |")/g) ?? []).length, 2);
});
await test('同一任务跨时间回到时间线：早间组合与下午记录分别保留，详情串联两次投入', () => {
  const morning = view.segments[0];
  assert.ok(morning);
  const later = {
    ...morning,
    segmentId: 'mic-afternoon',
    activityIds: ['later-record'],
    start: `${day}T14:00:00+08:00`,
    end: `${day}T14:02:00+08:00`,
    action: '下午继续测试输入',
  };
  const repeated = { ...view, segments: [...view.segments, later] };
  const text = renderToStaticMarkup(
    createElement(TaskTimeline, {
      view: repeated,
      activities: snapshot.activities,
      filter: 'all',
      selected: null,
      pending: null,
      onSelect: () => {},
      onLocated: () => {},
    }),
  );
  assert.equal((text.match(/data-testid="activity-card"/g) ?? []).length, 2);
  assert.ok(text.indexOf('09:00') < text.indexOf('14:00'));
  const detail = renderToStaticMarkup(
    createElement(TaskDetails, {
      view: repeated,
      segment: later,
      activities: snapshot.activities,
      onClose: () => {},
      onNavigate: () => {},
      onImage: () => {},
    }),
  );
  assert.equal((detail.match(/class="investment-link/g) ?? []).length, 2);
  assert.ok(detail.includes('14:00'));
  assert.ok(detail.includes('09:00'));
});
await test('多任务详情：进展和原文按所选任务隔离，图号或待确认范围可见', () => {
  const segment = view.segments[0];
  assert.ok(segment);
  const text = renderToStaticMarkup(
    createElement(TaskDetails, {
      view,
      segment,
      activities: snapshot.activities,
      onClose: () => {},
      onNavigate: () => {},
      onImage: () => {},
    }),
  );
  assert.ok(text.includes('麦克风进展'));
  assert.ok(text.includes('麦克风原文'));
  assert.ok(text.includes('查看图1'));
  assert.ok(!text.includes('博客进展'));
  assert.ok(!text.includes('博客原文'));
});
await test('多任务档案：一条记录、两个应用、两个任务，正文保持', () => {
  const review = DailyReviewSchema.parse({
    day,
    generatedAt: end,
    sourceCount: 1,
    sourceHash: 'a'.repeat(64),
    response: '完整回顾',
  });
  const tasks = TimelineReadReplySchema.parse({
    day,
    sourceRevision: 'source',
    taskRevision: '',
    evidenceRevision: '',
    organizing: 'idle',
    coveredUntil: end,
    issues: [],
    view,
  });
  const archive = buildDailyArchive(review, snapshot, tasks);
  assert.equal(archive.statistics.activityCount, 1);
  assert.equal(archive.statistics.appCount, 2);
  assert.equal(archive.statistics.taskCount, 2);
  assert.equal(archive.review.response, '完整回顾');
});

await test('证据图片：按当前记录的1基帧号读取原图，越界保持缺失', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { readSnapshotImage } = await import('../src/main/data');
  const folder = await mkdtemp(path.resolve('../tmp/frame-read-'));
  try {
    const group = Buffer.from([255, 216, 255, 1]);
    const original = Buffer.from([255, 216, 255, 3]);
    await writeFile(path.join(folder, 'group.jpg'), group);
    await writeFile(path.join(folder, 'frame.jpg'), original);
    const activity = snapshot.activities[0];
    assert.ok(activity);
    const data = SnapshotSchema.parse({
      ...snapshot,
      locations: { ...snapshot.locations, home: folder },
      activities: [
        {
          ...activity,
          screenshot: 'group.jpg',
          frames: [
            { capturedAt: start, app: 'Editor', screenshot: 'frame.jpg' },
          ],
        },
      ],
    });
    const all = await readSnapshotImage(data, 'record');
    const frame = await readSnapshotImage(data, 'record', 1);
    assert.equal(all.status, 'ready');
    assert.equal(frame.status, 'ready');
    if (all.status === 'ready' && frame.status === 'ready') {
      assert.equal(
        all.dataUrl,
        `data:image/jpeg;base64,${group.toString('base64')}`,
      );
      assert.equal(
        frame.dataUrl,
        `data:image/jpeg;base64,${original.toString('base64')}`,
      );
    }
    assert.equal(
      (await readSnapshotImage(data, 'record', 2)).status,
      'missing',
    );
    assert.equal((await readSnapshotImage(data, 'other', 1)).status, 'missing');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
