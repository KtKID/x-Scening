import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { localDay, moveDay } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = path.dirname(desktop);
const report = path.join(
  project,
  process.env.PIPELINE_REPORT_DIR ??
    'reports/backfill-pipeline-20261104/evidence',
);
const preview = path.join(
  project,
  process.env.PIPELINE_PREVIEW_DIR ?? 'tmp/backfill-pipeline-preview',
);
const entry = path.join(desktop, '.cache/backfill-pipeline/index.html');
await mkdir(path.dirname(entry), { recursive: true });
await mkdir(path.join(report, 'coverage'), { recursive: true });
await mkdir(preview, { recursive: true });
await writeFile(
  entry,
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/src/style.css?direct"><div id="root"></div><script type="module" src="/tests/backfill-pipeline.fixture.tsx"></script></html>',
);
const server = await createServer({
  configFile: false,
  root: desktop,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors: string[] = [];
const checks: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.coverage.startJSCoverage({ resetOnNavigation: false });
await page.coverage.startCSSCoverage({ resetOnNavigation: false });
page.setDefaultTimeout(6000);
try {
  const url = server.resolvedUrls?.local[0];
  assert.ok(url);
  await page.goto(`${url}.cache/backfill-pipeline/index.html`);
  const panel = page.getByRole('region', { name: '补分析页面' });
  await panel.getByRole('heading', { name: '待补分析', exact: true }).waitFor();
  const stages = panel.locator('.backfill-stage');
  assert.equal(await stages.count(), 3, 'T1：三个流水线节点');
  const dateIcon = panel.locator('.backfill-date-icon');
  assert.equal(await dateIcon.isVisible(), true, '日期图标常驻');
  const iconBox = await dateIcon.boundingBox();
  assert.ok(iconBox);
  await page.mouse.click(
    iconBox.x + iconBox.width / 2,
    iconBox.y + iconBox.height / 2,
  );
  await page.screenshot({ path: path.join(preview, 'date-picker-open.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(await stages.locator('h3').allTextContents(), [
    '本地截图',
    '补分析',
    '任务关联',
  ]);
  assert.equal(await panel.getByRole('button').count(), 1);
  const button = panel.getByRole('button');
  const progress = panel.getByRole('progressbar', { name: '截图分析进度' });
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(117, 103, 70)',
  );
  await button.hover();
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(101, 87, 53)',
  );
  await page.mouse.move(0, 0);
  assert.equal(
    await progress.evaluate((el) => getComputedStyle(el).accentColor),
    'rgb(139, 107, 69)',
  );
  assert.equal(await progress.getAttribute('value'), '3');
  await page.screenshot({ path: path.join(preview, 'ready.png') });
  checks.push('T1：三个节点、单按钮与原棕色正常/悬停/进度条通过。');

  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  await page.evaluate(() => {
    window.pipelineFixture.update({
      backfill: { analyzed: 6, remaining: 3 },
    });
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.pipeline-packet').length === 2,
  );
  const transfer = panel.locator('.pipeline-transfer').first();
  assert.equal(
    await panel
      .locator('.pipeline-packet')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    'pipeline-transfer',
  );
  assert.equal(
    await panel
      .locator('.pipeline-packet')
      .first()
      .evaluate((el) => getComputedStyle(el).animationIterationCount),
    '1',
  );
  const revision = await transfer.getAttribute('data-revision');
  await page.evaluate(() => {
    window.pipelineFixture.update({ backfill: { analyzed: 6, remaining: 3 } });
  });
  await page.waitForTimeout(180);
  assert.equal(await transfer.getAttribute('data-revision'), revision);
  await page.evaluate(() => {
    window.pipelineFixture.update({ task: { taskRevision: 'task-2' } });
  });
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll('.pipeline-transfer')[1]
        ?.getAttribute('data-revision') === '2',
  );
  checks.push(
    'T2：初次静态，保存增量触发两段，重复数据保持序号，关联提交触发第二段。',
  );

  await page.evaluate(() =>
    window.pipelineFixture.update({ task: { organizing: 'disabled' } }),
  );
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll('.pipeline-transfer')[1]
        ?.getAttribute('data-revision') === '0',
  );
  await page.evaluate(() =>
    window.pipelineFixture.update({ task: { organizing: 'idle' } }),
  );
  await page.waitForTimeout(120);
  assert.equal(
    await panel
      .locator('.pipeline-transfer')
      .last()
      .getAttribute('data-revision'),
    '0',
  );

  const today = localDay();
  await page.evaluate((day) => {
    window.pipelineFixture.update({
      taskDay: day,
      task: { day, pendingCount: 4, organizing: 'running' },
      running: { running: true, day },
    });
  }, today);
  const association = panel.getByRole('complementary', {
    name: '任务关联进度',
  });
  await association.getByText(`查看日期 ${today}`).waitFor();
  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  await association.getByText('待关联 4 条', { exact: true }).waitFor();
  const other = moveDay(today, -3);
  await page.evaluate((day) => {
    window.pipelineFixture.update({ running: { running: true, day } });
  }, other);
  await association.getByText(`查看日期 ${other}`).waitFor();
  await association.getByText('待关联 — 条', { exact: true }).waitFor();
  await page.evaluate((day) => {
    window.pipelineFixture.update({ running: null, taskDay: day });
  }, other);
  await association.getByText('正在读取', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.pipelineFixture.reset();
    window.pipelineFixture.update({ task: { organizing: 'disabled' } });
  });
  await association.getByText('已停用', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.pipelineFixture.update({ backfill: { analyzed: 6, remaining: 3 } });
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.pipeline-packet').length === 1,
  );
  await page.evaluate(() => {
    window.pipelineFixture.update({
      task: { organizing: 'failed', issues: ['关联问题：'.repeat(100)] },
    });
  });
  await association.getByText('整理失败', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.pipelineFixture.update({
      task: { organizing: 'idle', needsOrganization: false, pendingCount: 0 },
    });
  });
  await association.getByText('已同步', { exact: true }).waitFor();
  checks.push(
    'T3：跨日、其他进程日期、未知数量、停用/失败/同步及长问题文字通过。',
  );

  await page.evaluate(() => {
    window.pipelineFixture.reset();
    window.pipelineFixture.update({ holdRead: true });
  });
  await panel
    .getByRole('heading', { name: '正在核对截图…', exact: true })
    .waitFor();
  assert.equal(await progress.count(), 0);

  await page.evaluate(() => window.pipelineFixture.reset());
  await button.getByText('开始补分析', { exact: true }).waitFor();
  const selectedDay = await panel.getByLabel('补分析日期').inputValue();
  await button.click();
  await panel.getByRole('heading', { name: '补分析中', exact: true }).waitFor();
  assert.equal(await panel.getByLabel('补分析日期').inputValue(), selectedDay);
  assert.equal(await panel.getByLabel('补分析日期').isDisabled(), true);
  assert.equal(await dateIcon.isVisible(), true, '运行中保留日期图标');
  const dateInput = panel.getByLabel('补分析日期');
  const lockedStyle = await dateInput.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      color: style.color,
      cursor: style.cursor,
    };
  });
  assert.deepEqual(lockedStyle, {
    background: 'rgb(233, 231, 226)',
    color: 'rgb(134, 131, 123)',
    cursor: 'not-allowed',
  });
  assert.equal(
    await dateIcon.evaluate((el) => getComputedStyle(el).color),
    'rgb(134, 131, 123)',
  );
  const lockedIcon = await dateIcon.boundingBox();
  assert.ok(lockedIcon);
  await page.mouse.click(
    lockedIcon.x + lockedIcon.width / 2,
    lockedIcon.y + lockedIcon.height / 2,
  );
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await dateInput.inputValue(),
    selectedDay,
    '禁用时点击和按键保持原日期',
  );
  await page.screenshot({ path: path.join(preview, 'date-locked.png') });
  await panel.getByRole('button', { name: '停止补分析' }).click();
  await panel.getByRole('heading', { name: '已停止', exact: true }).waitFor();
  assert.equal(await panel.getByLabel('补分析日期').isEnabled(), true);
  assert.equal(await panel.getByLabel('补分析日期').inputValue(), selectedDay);
  assert.equal(await dateIcon.isVisible(), true, '停止后保留日期图标');
  assert.equal(
    await dateInput.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(247, 241, 227)',
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.pipelineFixture.calls.map((call) => call.action),
    ),
    ['start', 'stop'],
  );
  await page.evaluate(() =>
    window.pipelineFixture.update({ controlError: true, holdRead: true }),
  );
  await panel.getByRole('button', { name: '继续补分析' }).click();
  await panel.getByRole('button', { name: '重新核对' }).waitFor();
  await page.evaluate(() =>
    window.pipelineFixture.update({ controlError: false, holdRead: false }),
  );
  await panel.getByRole('button', { name: '重新核对' }).click();
  await panel.getByRole('button', { name: '继续补分析' }).waitFor();
  await page.evaluate(() => window.pipelineFixture.update({ readError: true }));
  await panel.getByRole('heading', { name: /核对失败/ }).waitFor();
  assert.equal(await progress.count(), 0);
  await page.evaluate(() =>
    window.pipelineFixture.update({ readError: false }),
  );
  await panel.getByRole('button', { name: '继续补分析' }).waitFor();
  await page.evaluate(() =>
    window.pipelineFixture.update({
      backfill: { state: 'running', activeDay: null, owned: false },
    }),
  );
  await panel.getByRole('heading', { name: '补分析中', exact: true }).waitFor();
  assert.equal(await button.isDisabled(), true);
  const cases = [
    {
      state: 'completed',
      total: 9,
      analyzed: 9,
      remaining: 0,
      eligible: true,
      label: '全部已分析',
      hasProgress: true,
    },
    {
      state: 'empty',
      total: 0,
      analyzed: 0,
      remaining: 0,
      eligible: true,
      label: '这一天暂无截图',
      hasProgress: false,
    },
    {
      state: 'error',
      total: null,
      analyzed: null,
      remaining: null,
      eligible: true,
      label: '核对失败',
      hasProgress: false,
    },
    {
      state: 'idle',
      total: 9,
      analyzed: 3,
      remaining: 6,
      eligible: false,
      label: '待补分析',
      hasProgress: true,
    },
  ] as const;
  for (const item of cases) {
    await page.evaluate((value) => {
      const { label, hasProgress, ...backfill } = value;
      void label;
      void hasProgress;
      window.pipelineFixture.update({ backfill });
    }, item);
    await panel
      .getByRole('heading', { name: item.label, exact: true })
      .waitFor();
    assert.equal(await progress.count(), item.hasProgress ? 1 : 0);
    assert.equal(await button.isDisabled(), item.state !== 'error');
  }
  await page.evaluate(() =>
    window.pipelineFixture.update({
      backfill: {
        state: 'partial',
        eligible: true,
        total: 9,
        analyzed: 3,
        remaining: 6,
      },
    }),
  );
  await panel.getByRole('button', { name: '继续补分析' }).waitFor();
  await page.evaluate(() =>
    window.pipelineFixture.update({ backfill: { state: 'failed' } }),
  );
  await panel
    .getByRole('heading', { name: '补分析中断', exact: true })
    .waitFor();
  checks.push(
    'T4：开始/停止、控制错误恢复、读取失败、外部任务、完成/空日/未知/未来/部分失败通过。',
  );

  await page.evaluate(() => window.pipelineFixture.reset());
  await panel.getByRole('heading', { name: '待补分析', exact: true }).waitFor();
  await page.evaluate(() => window.pipelineFixture.update({ active: false }));
  const reads = await page.evaluate(() => window.pipelineFixture.reads);
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.pipelineFixture.reads), reads);
  await page.evaluate(() =>
    window.pipelineFixture.update({
      active: true,
      backfill: { analyzed: 6, remaining: 3 },
    }),
  );
  await page.waitForTimeout(180);
  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  await panel.getByLabel('补分析日期').fill(moveDay(today, -4));
  await page.waitForTimeout(180);
  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  for (const width of [1100, 850, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await panel.evaluate((el) => ({
      client: el.clientWidth,
      scroll: el.scrollWidth,
    }));
    assert.ok(bounds.scroll <= bounds.client, `${width}px内容保持完整`);
    assert.equal(await button.isVisible(), true);
    assert.equal(await panel.getByLabel('补分析日期').isVisible(), true);
  }
  await page.evaluate(() =>
    window.pipelineFixture.update({ backfill: { analyzed: 9, remaining: 0 } }),
  );
  await page.waitForFunction(
    () => document.querySelectorAll('.pipeline-packet').length === 1,
  );
  assert.equal(
    await panel
      .locator('.pipeline-packet')
      .evaluate((el) => getComputedStyle(el).animationName),
    'pipeline-transfer-vertical',
  );
  await page.waitForTimeout(1000);
  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  await page.screenshot({
    path: path.join(preview, 'narrow.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1100, height: 850 });
  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  checks.push(
    'T5：隐藏停止读取，恢复和切日期保持静态，1100/850/600/390/320像素均可读。',
  );

  await page.setViewportSize({ width: 1100, height: 850 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.pipelineFixture.reset());
  await panel.getByRole('heading', { name: '待补分析', exact: true }).waitFor();
  await page.evaluate(() =>
    window.pipelineFixture.update({ backfill: { analyzed: 6, remaining: 3 } }),
  );
  await page.waitForFunction(
    () => document.querySelector('progress')?.value === 6,
  );
  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() =>
    window.pipelineFixture.update({ backfill: { analyzed: 9, remaining: 0 } }),
  );
  await page.waitForFunction(
    () => document.querySelectorAll('.pipeline-packet').length === 2,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(
    () => document.querySelectorAll('.pipeline-packet').length === 0,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await panel.locator('.pipeline-packet').count(), 0);
  checks.push('T6：减弱动态保留数量更新并关闭CSS动画。');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.screenshot({ path: path.join(preview, 'final.png') });
  assert.deepEqual(errors, []);
} finally {
  const js = await page.coverage.stopJSCoverage();
  const css = await page.coverage.stopCSSCoverage();
  await writeFile(
    path.join(report, 'coverage/renderer.json'),
    JSON.stringify(js),
  );
  await writeFile(
    path.join(report, 'coverage/styles.json'),
    JSON.stringify(css),
  );
  await writeFile(
    path.join(report, 'pipeline.json'),
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
  await server.close();
  await rm(path.dirname(entry), { recursive: true, force: true });
}
console.log(JSON.stringify({ checks, errors }, null, 2));
