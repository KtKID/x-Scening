import test from 'node:test';
import { archiveHtml } from '../src/main/archive-html';
import assert from 'node:assert/strict';
import { buildDailyArchive } from '../src/shared/daily-archive';
import { SnapshotSchema } from '../src/shared/protocol';
import {
  DailyReviewSchema,
  TimelineReadReplySchema,
} from '../src/shared/scening.generated';

const day = '2026-11-01';
const review = DailyReviewSchema.parse({
  day,
  generatedAt: `${day}T10:20:00+08:00`,
  sourceCount: 2,
  sourceHash: 'a'.repeat(64),
  response: '完整回顾\n\n第二段 <script>不会执行</script> & 内容'.repeat(25),
});
const snapshot = SnapshotSchema.parse({
  day,
  source: 'local',
  sourceRevision: 'revision',
  summaries: [],
  issues: [],
  locations: { configPath: '', home: '', screenshotDir: '' },
  activities: [
    {
      id: 'one',
      title: '一',
      app: '旧应用',
      start: `${day}T09:00:00+08:00`,
      end: `${day}T09:01:00+08:00`,
      analysis: '活动一',
      screenshot: 'a.jpg',
      mini: 'a.jpg',
      frames: ['Editor', 'Browser', 'Editor'].map((app) => ({
        app,
        capturedAt: `${day}T09:00:00+08:00`,
        screenshot: 'a.jpg',
        screen: 1,
      })),
      observation: {
        schema_version: 1,
        visible_activity: '一',
        inferred_intent: '二',
        stage_and_evidence: '三',
        app_tags: ['错误模型应用'],
        task_types: ['工作', '学习', '工作'],
      },
    },
    {
      id: 'two',
      title: '二',
      app: 'Editor',
      start: `${day}T10:00:00+08:00`,
      end: `${day}T10:01:00+08:00`,
      analysis: '活动二',
      screenshot: 'b.jpg',
      mini: 'b.jpg',
    },
    {
      id: 'three',
      title: '三',
      app: '未知应用',
      start: `${day}T11:00:00+08:00`,
      end: `${day}T11:01:00+08:00`,
      analysis: '活动三',
      screenshot: 'c.jpg',
      mini: 'c.jpg',
    },
  ],
});
const tasks = TimelineReadReplySchema.parse({
  day,
  sourceRevision: 'revision',
  taskRevision: '',
  evidenceRevision: '',
  organizing: 'idle',
  coveredUntil: null,
  issues: [],
  view: {
    day,
    issues: [],
    tasks: [],
    segments: ['one', 'two', 'three'].map((id, index) => ({
      segmentId: id,
      taskId: index === 2 ? null : 'same-task',
      activityIds: [id],
      start: `${day}T09:00:00+08:00`,
      end: `${day}T09:01:00+08:00`,
      action: '记录',
      estimateSeconds: 60,
      partial: false,
      sliceIds: [],
      pointIds: [],
    })),
    progress: [],
    slices: [],
    points: [],
    totals: [],
    start: null,
    end: null,
    coveredUntil: null,
  },
});

await test('档案统计：全日记录、采集应用去重、同一任务去重、多选和待分类采用明确口径', () => {
  const original = JSON.stringify(snapshot);
  const archive = buildDailyArchive(
    review,
    snapshot,
    tasks,
    `${day}T10:00:00+08:00`,
  );
  assert.equal(archive.statistics.activityCount, 3);
  assert.equal(archive.statistics.appCount, 2);
  assert.equal(archive.statistics.taskCount, 1);
  assert.deepEqual(archive.statistics.categories, [
    { name: '待分类', count: 2 },
    { name: '工作', count: 1 },
    { name: '学习', count: 1 },
  ]);
  assert.equal(archive.statistics.pendingTasks, true);
  assert.equal(archive.review.response, review.response);
  assert.equal(JSON.stringify(snapshot), original);
});

await test('档案统计：过期或错日任务投影保持待整理，跨日正文拒绝混入', () => {
  for (const reply of [
    null,
    { ...tasks, sourceRevision: 'stale' },
    { ...tasks, day: '2026-10-31' },
  ])
    assert.equal(
      buildDailyArchive(review, snapshot, reply).statistics.taskCount,
      null,
    );
  assert.throws(
    () => buildDailyArchive({ ...review, day: '2026-10-31' }, snapshot, tasks),
    /日期/,
  );
});

await test('档案导出模板：完整多段正文转义并与阅读共用组件，含来源/统计/测试标记', () => {
  const archive = buildDailyArchive(review, snapshot, tasks);
  const html = archiveHtml(archive);
  assert.ok(html.includes('&lt;script&gt;不会执行&lt;/script&gt; &amp; 内容'));
  assert.ok(!html.includes('<script>'));
  assert.equal(html.split('第二段').length - 1, 25);
  assert.ok(html.includes('white-space:pre-wrap'));
  assert.ok(html.includes('按分类次数 · 多选分别计入'));
  assert.ok(html.includes('依据 2 份周期总结'));
  assert.ok(
    archiveHtml({ ...archive, source: 'demo' }).includes('【测试数据】'),
  );
});

await test('新日报告来源：仅活动和混合来源完整显示，旧报告兼容周期份数', () => {
  const html = (sourceCount: number, sourceActivityCount: number | null) =>
    archiveHtml(
      buildDailyArchive(
        DailyReviewSchema.parse({
          ...review,
          sourceCount,
          sourceActivityCount,
        }),
        snapshot,
        tasks,
        `${day}T12:00:00+08:00`,
      ),
    );
  assert.match(html(0, 3), /依据 3 条已保存分析/);
  assert.match(html(2, 3), /依据 3 条已保存分析和 2 份周期总结/);
  assert.match(html(2, null), /依据 2 份周期总结/);
});
