import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskDetails } from '../src/renderer/src/TaskDetails';
import { DayTaskViewSchema } from '../src/shared/scening.generated';

await test('完成判断停用：旧视图保留活动与来源，详情撤下完成范围与状态文案', () => {
  const start = '2026-10-30T09:00:00+08:00';
  const end = '2026-10-30T09:01:00+08:00';
  const segment = {
    segmentId: 'segment',
    taskId: 'article',
    activityIds: ['activity'],
    start,
    end,
    action: '修改文章首段',
    estimateSeconds: 60,
    partial: false,
    sliceIds: [],
    pointIds: [],
  };
  const view = DayTaskViewSchema.parse({
    day: '2026-10-30',
    tasks: [
      {
        taskId: 'article',
        day: '2026-10-30',
        title: '编辑设计文章',
        object: '设计文章',
        goal: '调整措辞',
      },
    ],
    segments: [segment],
    progress: [
      {
        progressId: 'progress',
        taskId: 'article',
        text: '首段文字已修改',
        kind: 'observed',
        completionScope: '历史字段中的整体完成结论',
        evidence: [
          {
            activityId: 'activity',
            sourceSignature: 'signature',
            excerpt: '修改文章首段',
          },
        ],
      },
    ],
    slices: [],
    points: [],
    totals: [],
    issues: [],
    start,
    end,
    coveredUntil: end,
  });
  const markup = renderToStaticMarkup(
    createElement(TaskDetails, {
      view,
      segment,
      activities: [],
      onClose: () => {},
      onNavigate: () => {},
      onImage: () => {},
    }),
  );
  assert.ok(markup.includes('首段文字已修改'));
  assert.ok(markup.includes('修改文章首段'));
  assert.doesNotMatch(markup, /完成范围|完成状态|历史字段中的整体完成结论/);
});
