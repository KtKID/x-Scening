import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { localDay } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/daily-review');
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(evidence, 'e2e-'));
const home = path.join(temporary, 'home');
const day = localDay();
const errors: string[] = [];
const results: string[] = [];
await mkdir(path.join(home, 'summaries'), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temporary, '.venv'));
await symlink(path.join(root, 'src'), path.join(temporary, 'src'));
const model = path.join(temporary, 'model.mjs');
await writeFile(
  model,
  `import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
appendFileSync(path.join(import.meta.dirname, 'calls.txt'), 'call\\n');
const response = readFileSync(path.join(import.meta.dirname, 'reply.txt'), 'utf8');
setTimeout(() => { if (response === 'FAIL') process.exit(2); process.stdout.write(response); }, 1200);`,
);
await writeFile(
  path.join(temporary, 'reply.txt'),
  '今天你在推进 Observer 的采集模块，也整理了客户端的设计思路。定位启动问题确实花了一些心力，你一次次缩小范围的过程，也在积累新的线索。\n\n这些细小的进展都值得被看见。辛苦了，留一点时间休息，按自己的节奏继续吧。',
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', home);
config.set('screenshotDir', path.join(temporary, 'snapshots'));
config.set('kmhLauncher', model);
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
const periods = [
  {
    windowStart: `${day}T09:00:00+08:00`,
    windowEnd: `${day}T09:30:00+08:00`,
    generatedAt: `${day}T09:31:00+08:00`,
    summary: '推进 Observer 采集，正在定位启动问题。',
    timeline: [],
    gaps: [],
    trigger: 'periodic',
  },
  {
    windowStart: `${day}T10:00:00+08:00`,
    windowEnd: `${day}T10:30:00+08:00`,
    generatedAt: `${day}T10:31:00+08:00`,
    summary: '整理客户端设计思路。',
    timeline: [],
    gaps: [],
    trigger: 'periodic',
  },
];
const sourcePath = path.join(home, 'summaries', `${day}.json`);
const original = JSON.stringify(periods);
await writeFile(sourcePath, original);
const packaged = process.env.DAILY_REVIEW_PACKAGED === '1';
const application = await electron.launch({
  executablePath: packaged
    ? path.join(
        desktop,
        'release/mac-arm64/x-scening.app/Contents/MacOS/Observer',
      )
    : path.join(
        desktop,
        'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      ),
  args: packaged ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: temporary,
    OBSERVER_CONFIG: path.join(temporary, 'observer.yaml'),
  },
  timeout: 30000,
});
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  assert.equal(
    (await page.locator('.source-badge').textContent())?.trim(),
    '本地记录',
  );
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /测试预览.*使用标有/ }).click();
  const overview = page.locator('.overview');
  const generateReview = async (): Promise<void> => {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /^(回顾|总结)$/, exact: true })
      .click();
    await page.getByRole('tab', { name: '每日总结', exact: true }).click();
    await page
      .locator('.daily-center-summary')
      .or(
        page
          .locator('.daily-archive-sheet')
          .getByRole('button', { name: '重新生成', exact: true }),
      )
      .click();
  };
  await overview.getByRole('button', { name: '展示总结', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '当日档案', exact: true });
  await dialog.waitFor();
  await dialog.locator('.review-prose').waitFor();
  await dialog.getByText('【测试数据】', { exact: false }).first().waitFor();
  await page.keyboard.press('Tab');
  assert.equal(
    await dialog
      .getByRole('button', { name: '回到时间线' })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await overview.getByRole('button', { name: '展示总结', exact: true }).click();
  await dialog.waitFor();
  await dialog.locator('.review-prose').waitFor();
  await page.mouse.click(10, 10);
  assert.equal(await page.getByRole('dialog').count(), 0);
  results.push(
    '测试模式：概览按钮打开带测试标记的模态回顾，Tab保持模态焦点、Escape和遮罩点击均可关闭。',
  );
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /本地记录.*只读查看/ }).click();
  await generateReview();
  const loading = dialog.getByRole('button', { name: '总结中', exact: true });
  await loading.waitFor();
  assert.equal(await loading.isDisabled(), true);
  assert.equal(await page.locator('dialog:modal').count(), 1);
  await page.screenshot({ path: path.join(evidence, 'summarizing.png') });
  await dialog.waitFor();
  await dialog.locator('.review-prose').waitFor();
  assert.match((await dialog.textContent()) ?? '', /2 份周期总结/);
  assert.equal(
    await overview
      .getByRole('button', { name: '展示总结', exact: true })
      .isEnabled(),
    true,
  );
  await page.screenshot({ path: path.join(evidence, 'daily-review.png') });
  const target = path.join(home, 'daily-reviews', `${day}.json`);
  const saved = await readFile(target, 'utf8');
  assert.equal(await readFile(sourcePath, 'utf8'), original);
  await dialog.getByRole('button', { name: '回到时间线' }).click();
  await page
    .getByRole('heading', { name: '这一天暂无活动', exact: true })
    .waitFor();
  results.push(
    '每日页生成：弹窗按钮禁用并显示总结中，等待期间显示进度；实际Python/子进程完成后原地显示正文，恢复按钮；2个时段汇总保存且周期总结原文件一致。',
  );
  await writeFile(
    path.join(temporary, 'reply.txt'),
    '第二次生成的完整回复。每日页重新生成会汇总当天的时间段。',
  );
  await generateReview();
  await loading.waitFor();
  await dialog
    .getByText('第二次生成的完整回复。每日页重新生成会汇总当天的时间段。')
    .waitFor();
  assert.notEqual(await readFile(target, 'utf8'), saved);
  const updated = await readFile(target, 'utf8');
  await page.getByRole('button', { name: '关闭每日总结' }).click();
  results.push(
    '每日页重新生成：真正重新调用模型并更新同日文件，弹窗显示新回复。',
  );
  await writeFile(path.join(temporary, 'reply.txt'), 'FAIL');
  await generateReview();
  await dialog.locator('.daily-error-details').waitFor();
  assert.equal(await readFile(target, 'utf8'), updated);
  assert.equal(await dialog.locator('.review-prose').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '前一天', exact: true }).click();
  await generateReview();
  await page
    .getByRole('dialog')
    .getByText('当日无记录', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  results.push('失败与空日期共用弹窗；失败保留旧正文和日文件，空日明确说明。');
  assert.equal(await overview.locator('button').count(), 0);
  await page.getByLabel('选择日期').fill(day);
  await overview
    .getByRole('button', { name: '展示总结', exact: true })
    .waitFor();
  await page.setViewportSize({ width: 850, height: 720 });
  assert.equal(
    await overview
      .getByRole('button', { name: '展示总结', exact: true })
      .isVisible(),
    true,
  );
  await page.screenshot({ path: path.join(evidence, 'narrow-overview.png') });
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.getByLabel('选择日期').fill('2026-10-20');
  const historicalPeriods = periods.map((period) => ({
    ...period,
    windowStart: period.windowStart.replace(day, '2026-10-20'),
    windowEnd: period.windowEnd.replace(day, '2026-10-20'),
    generatedAt: period.generatedAt.replace(day, '2026-10-20'),
  }));
  await writeFile(
    path.join(home, 'summaries/2026-10-20.json'),
    JSON.stringify(historicalPeriods),
  );
  await writeFile(path.join(temporary, 'reply.txt'), '历史日的完整回顾。');
  await generateReview();
  const historyDialog = page.getByRole('dialog', {
    name: '当日档案',
    exact: true,
  });
  await historyDialog.getByText('历史日的完整回顾。').waitFor();
  assert.match((await historyDialog.textContent()) ?? '', /2026 \/ 10 \/ 20/);
  await page.getByRole('button', { name: '关闭每日总结' }).click();
  results.push(
    '日期与窗口：历史日期真实生成并弹出对应日期的回顾，850px窗口保留右侧总结入口。',
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^(回顾|总结)$/, exact: true })
    .click();
  const tabs = page.getByRole('tablist', { name: '总结类型' });
  await tabs.waitFor();
  await tabs.getByRole('tab', { name: '半小时总结', exact: true }).click();
  assert.equal(
    await tabs
      .getByRole('tab', { name: '半小时总结' })
      .getAttribute('aria-selected'),
    'true',
  );
  await page.getByRole('heading', { name: '活动总结', exact: true }).waitFor();
  await tabs.getByRole('tab', { name: '每日总结' }).click();
  await page
    .locator('.daily-archive-sheet')
    .getByText('历史日的完整回顾。')
    .waitFor();
  assert.equal(await page.locator('.daily-archive-sheet').count(), 1);
  await page.screenshot({ path: path.join(evidence, 'summary-daily-tab.png') });
  await page.keyboard.press('Escape');
  await page.getByLabel('选择日期').fill(day);
  await page
    .locator('.daily-archive-sheet')
    .getByText('第二次生成的完整回复。每日页重新生成会汇总当天的时间段。')
    .waitFor();
  await writeFile(
    path.join(temporary, 'reply.txt'),
    '总结页重新生成的完整回复。',
  );
  await page
    .locator('.daily-archive-sheet')
    .getByRole('button', { name: '重新生成', exact: true })
    .click();
  await dialog.getByRole('button', { name: '总结中', exact: true }).waitFor();
  await dialog.getByText('总结页重新生成的完整回复。').waitFor();
  assert.match(await readFile(target, 'utf8'), /总结页重新生成的完整回复/);
  await page.keyboard.press('Escape');
  results.push('每日tab直接读取并展示已有报告，重新生成复用档案弹窗。');
  // 有资料的历史日由同一弹窗生成，导出继续使用原有保存按钮。
  await writeFile(
    path.join(home, 'summaries/2026-10-21.json'),
    JSON.stringify(
      historicalPeriods.map((period) => ({
        ...period,
        windowStart: period.windowStart.replace('2026-10-20', '2026-10-21'),
        windowEnd: period.windowEnd.replace('2026-10-20', '2026-10-21'),
        generatedAt: period.generatedAt.replace('2026-10-20', '2026-10-21'),
      })),
    ),
  );
  const modelCalls = async (): Promise<number> =>
    (await readFile(path.join(temporary, 'calls.txt'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean).length;
  const callsBefore = await modelCalls();
  await tabs.getByRole('tab', { name: '每日总结' }).click();
  await page.getByLabel('选择日期').fill('2026-10-21');
  const generate = page.locator('.daily-center-summary');
  await generate.waitFor();
  assert.equal(await modelCalls(), callsBefore, '打开每日tab不得调用模型');
  assert.equal(
    existsSync(path.join(home, 'daily-reviews/2026-10-21.json')),
    false,
  );
  await writeFile(path.join(temporary, 'reply.txt'), '2026-10-21的完整回顾。');
  await generate.click();
  await dialog.getByRole('button', { name: '总结中', exact: true }).waitFor();
  await dialog.getByText('2026-10-21的完整回顾。').waitFor();
  assert.equal(await modelCalls(), callsBefore + 1);
  assert.equal(await page.getByRole('dialog').count(), 1);
  const sheetImage = path.join(evidence, 'summary-daily-archive.png');
  await rm(sheetImage, { force: true });
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath });
  }, sheetImage);
  await dialog.getByRole('button', { name: '保存图片', exact: true }).click();
  await dialog
    .getByRole('status')
    .filter({ hasText: '图片已保存' })
    .waitFor({ timeout: 30000 });
  const sheetPng = await readFile(sheetImage);
  assert.equal(sheetPng.subarray(1, 4).toString(), 'PNG');
  assert.equal(sheetPng.readUInt32BE(16), 1080);
  await page.screenshot({
    path: path.join(evidence, 'summary-daily-dialog.png'),
  });
  results.push(
    '只读与按钮：有周期总结无日文件时打开每日tab零模型调用、不写文件；“生成总结”按钮触发一次生成并在统一弹窗显示档案；弹窗“保存图片”输出1080宽PNG。',
  );
  assert.deepEqual(errors, []);
} catch (error: unknown) {
  const page = await application.firstWindow();
  await page.screenshot({ path: path.join(evidence, 'failure.png') });
  await writeFile(path.join(evidence, 'failure.html'), await page.content());
  throw error;
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
const output = {
  packaged,
  results,
  errors,
  count: results.length,
  model: '受控子进程替身；Python生成、IPC和文件保存为真实路径',
};
await writeFile(
  path.join(
    root,
    `reports/daily-review-20261028/${packaged ? 'packaged-electron-e2e' : 'electron-e2e'}.json`,
  ),
  JSON.stringify(output, null, 2),
);
console.log(JSON.stringify(output, null, 2));
