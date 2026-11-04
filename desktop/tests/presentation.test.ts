import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardTitle,
  cardPreview,
  activityTime,
  capturedApplicationNames,
  capturedApplicationLabel,
  applicationCounts,
} from '../src/shared/presentation';
import { TimelineActivitySchema } from '../src/shared/protocol';

await test('T1 真实分析的事实短句作为卡片标题，预览整理格式且保留测试前缀', () => {
  const raw =
    '我先读取这张截图，然后给出观察正文。**可见事实**：终端进入 `observer` 项目目录，随后执行启动脚本。\n\n**推测**：正在检查采集。';
  assert.equal(cardTitle(raw), '终端进入 observer 项目目录');
  assert.equal(
    cardPreview(raw),
    '终端进入 observer 项目目录，随后执行启动脚本。',
  );
  assert.equal(
    cardTitle('可见事实：浏览器打开项目页面，查看目录。'),
    '浏览器打开项目页面',
  );
  assert.equal(
    cardTitle('**可见事实**：阅读一篇设计说明。\n\n**完成状态证据**：待确认。'),
    '阅读一篇设计说明',
  );
  assert.equal(
    cardPreview('可见事实：编辑文章。\n观察到的变化：首段措辞改变。'),
    '编辑文章。',
  );
  assert.equal(cardTitle('普通活动正文。下一句话。'), '普通活动正文');
  assert.ok(
    cardTitle('【测试数据】编写示例，核对样式。').startsWith('【测试数据】'),
  );
  assert.ok(
    cardPreview('【测试数据】用于界面预览。').startsWith('【测试数据】'),
  );
  assert.ok(raw.includes('我先读取这张截图'));
});

await test('T2 单次观察与同分钟短区间保留秒，正常区间沿用分钟', () => {
  const start = '2026-10-22T15:18:14+08:00';
  assert.equal(activityTime({ start, end: start }), '15:18:14 · 单次观察');
  assert.equal(
    activityTime({ start, end: '2026-10-22T15:18:59+08:00' }),
    '15:18:14 — 15:18:59',
  );
  assert.equal(
    activityTime({ start, end: '2026-10-22T15:45:10+08:00' }),
    '15:18 — 15:45',
  );
});

await test('T3 应用标签、筛选成员和统计统一取逐帧系统身份，模型标签保持独立', () => {
  const activity = TimelineActivitySchema.parse({
    id: 'mixed',
    title: '系统应用测试',
    start: '2026-10-29T09:00:00+08:00',
    end: '2026-10-29T09:00:40+08:00',
    app: 'Stale Captured App',
    analysis: '可见事实：核对应用来源。',
    screenshot: 'batch.jpg',
    mini: 'batch.jpg',
    frames: ['Editor', 'Browser', 'Editor'].map((app, index) => ({
      app,
      bundleId: app.toLowerCase(),
      capturedAt: `2026-10-29T09:00:${String(index * 20).padStart(2, '0')}+08:00`,
      screenshot: `${String(index)}.jpg`,
      screen: (index % 2) + 1,
    })),
    observation: {
      schema_version: 1,
      visible_activity: '核对应用。',
      inferred_intent: '验证。',
      stage_and_evidence: '待确认。',
      app_tags: ['Wrong Model App'],
    },
  });
  assert.deepEqual(capturedApplicationNames(activity), ['Editor', 'Browser']);
  assert.equal(capturedApplicationLabel(activity), 'Editor、Browser');
  assert.ok(capturedApplicationNames(activity).includes('Browser'));
  assert.deepEqual(applicationCounts([activity, activity]), [
    ['Editor', 2],
    ['Browser', 2],
  ]);
  assert.deepEqual(activity.observation?.app_tags, ['Wrong Model App']);
  assert.deepEqual(
    capturedApplicationNames({ ...activity, frames: null, app: 'Legacy App' }),
    ['Legacy App'],
  );
  assert.deepEqual(
    capturedApplicationNames({
      ...activity,
      frames: activity.frames?.map((frame) => ({ ...frame, app: null })) ?? [],
    }),
    ['未知应用'],
  );
});
