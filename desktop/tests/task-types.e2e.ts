import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { localDay } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence =
  process.env.TASK_TYPES_EVIDENCE ?? path.join(root, 'tmp/task-type-cards');
const report =
  process.env.TASK_TYPES_REPORT ??
  path.join(root, 'reports/task-type-cards-20261029');
await mkdir(evidence, { recursive: true });
await mkdir(report, { recursive: true });
const temporary = await mkdtemp(path.join(evidence, 'window-'));
const day = localDay();
const records = path.join(temporary, `home/records/${day}.json`);
await mkdir(path.dirname(records), { recursive: true });
await writeFile(
  path.join(temporary, 'home/screen.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8f28rAzbAhFV00EoAAPfdApLUYjL3AAAAAElFTkSuQmCC',
    'base64',
  ),
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', './home');
config.set('screenshotDir', './pictures');
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
const observation = {
  schema_version: 1,
  visible_activity: '【测试数据】核对卡片类型。',
  inferred_intent: '【测试数据】推测在检查展示。',
  stage_and_evidence: '【测试数据】展示验证中。',
  app_tags: ['Fixture App'],
};
const base = {
  app: 'Fixture App',
  screenshot: 'screen.png',
  mini: 'screen.png',
  source: 'screen',
};
const longType = '用于验证历史自定义类型在窄窗口中完整换行的名称'.repeat(3);
const rows = [
  {
    ...base,
    start: `${day}T09:00:00+08:00`,
    end: `${day}T09:01:00+08:00`,
    analysis: '【测试数据】多项类型活动。核对工作与学习标签。',
    observation: { ...observation, task_types: ['工作', '学习'] },
  },
  {
    ...base,
    start: `${day}T09:02:00+08:00`,
    end: `${day}T09:03:00+08:00`,
    analysis: '【测试数据】空列表活动。核对待分类状态。',
    observation: { ...observation, task_types: [] },
  },
  {
    ...base,
    start: `${day}T09:04:00+08:00`,
    end: `${day}T09:05:00+08:00`,
    analysis: '【测试数据】旧结果缺少类型。核对兼容展示。',
    observation,
  },
  {
    ...base,
    start: `${day}T09:06:00+08:00`,
    end: `${day}T09:07:00+08:00`,
    analysis: '【测试数据】旧活动没有观察对象。核对兼容展示。',
  },
  {
    ...base,
    start: `${day}T09:08:00+08:00`,
    end: `${day}T09:09:00+08:00`,
    analysis: '【测试数据】历史自定义类型。核对长名称与预设外历史值。',
    observation: {
      ...observation,
      task_types: ['已从预设移除的类型', longType],
    },
  },
];
const original = JSON.stringify(rows);
await writeFile(records, original);
const executable =
  process.platform === 'darwin'
    ? path.join(
        desktop,
        'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      )
    : path.join(
        desktop,
        `node_modules/electron/dist/${process.platform === 'win32' ? 'electron.exe' : 'electron'}`,
      );
const errors: string[] = [];
const application = await electron.launch({
  executablePath: executable,
  args: [desktop],
  env: { ...process.env, OBSERVER_PROJECT_ROOT: temporary },
  timeout: 30000,
});
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  const cards = page.getByTestId('activity-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 5);
  const labels = (index: number) =>
    cards
      .nth(index)
      .getByRole('list', { name: '任务类型' })
      .getByRole('listitem');
  assert.deepEqual(await labels(0).allTextContents(), ['工作', '学习']);
  for (const index of [1, 2, 3]) {
    assert.deepEqual(await labels(index).allTextContents(), ['待分类']);
  }
  assert.deepEqual(await labels(4).allTextContents(), [
    '已从预设移除的类型',
    longType,
  ]);
  await cards.first().click();
  const detailLabels = page
    .locator('.details')
    .getByRole('list', { name: '任务类型' })
    .getByRole('listitem');
  assert.deepEqual(await detailLabels.allTextContents(), ['工作', '学习']);
  await page.screenshot({ path: path.join(evidence, 'wide.png') });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await cards.nth(1).click();
  assert.deepEqual(await detailLabels.allTextContents(), ['待分类']);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.setViewportSize({ width: 850, height: 720 });
  await cards.nth(4).scrollIntoViewIfNeeded();
  const cardBox = await cards.nth(4).boundingBox();
  assert.ok(cardBox);
  for (const label of await labels(4).all()) {
    const box = await label.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= cardBox.x);
    assert.ok(box.x + box.width <= cardBox.x + cardBox.width);
    assert.ok(box.y + box.height <= cardBox.y + cardBox.height);
  }
  await page.screenshot({ path: path.join(evidence, 'narrow.png') });
  assert.equal(await readFile(records, 'utf8'), original);
  await page.setViewportSize({ width: 1440, height: 940 });
  await cards.first().click();
  const updated = JSON.stringify(
    rows.map((row, index) =>
      index === 0
        ? { ...row, observation: { ...observation, task_types: ['游戏'] } }
        : row,
    ),
  );
  await writeFile(records, updated);
  await labels(0).filter({ hasText: '游戏' }).waitFor();
  assert.deepEqual(await labels(0).allTextContents(), ['游戏']);
  assert.deepEqual(await detailLabels.allTextContents(), ['游戏']);
  assert.equal(await cards.first().getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  // 现行feat11场景9与当前客户端均保留仍存在的已选详情。
  assert.equal(await cards.first().getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await detailLabels.allTextContents(), ['游戏']);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('heading', { name: '当日概览', exact: true }).waitFor();
  assert.deepEqual(await labels(0).allTextContents(), ['游戏']);
  await cards.first().click();
  assert.deepEqual(await detailLabels.allTextContents(), ['游戏']);
  assert.equal(await readFile(records, 'utf8'), updated);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(report, 'window.json'),
    JSON.stringify(
      {
        cardCount: 5,
        multipleTypes: ['工作', '学习'],
        pendingCases: ['空列表', '旧结果缺项', '没有observation'],
        historicCustomTypesPreserved: true,
        longLabelContainedAt850px: true,
        detailAndRefresh: true,
        sourceReadOnly: true,
        pageErrors: errors,
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: 多项标签、三种待分类、历史长名称、窄窗口、详情和刷新均通过；页面错误0。',
  );
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
