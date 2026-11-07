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
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import type { ObserverBridge } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(
  root,
  'reports/fix/overview-summary-ready-20261104/evidence',
);
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/overview-summary-'));
const home = path.join(temporary, 'home');
const day = '2026-10-31';
const empty = '2026-10-29';
const response = '【测试数据】已保存的十月三十一日总结。';
const target = path.join(home, 'daily-reviews', `${day}.json`);
await mkdir(path.dirname(target), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temporary, '.venv'));
await symlink(path.join(root, 'src'), path.join(temporary, 'src'));
const saved = JSON.stringify({
  day,
  generatedAt: '2026-11-01T09:00:00+08:00',
  sourceCount: 1,
  sourceHash: 'a'.repeat(64),
  response,
});
await writeFile(target, saved);
const calls = path.join(temporary, 'calls.txt');
const model = path.join(temporary, 'model.mjs');
await writeFile(
  model,
  `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},'call');process.exit(2);`,
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', home);
config.set('screenshotDir', path.join(temporary, 'snapshots'));
config.set('kmhLauncher', model);
config.setIn(['dailyReview', 'scheduledTime'], '23:59');
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
const app = await electron.launch({
  executablePath: path.join(
    desktop,
    process.env.OVERVIEW_SUMMARY_PACKAGED === '1'
      ? 'release/mac-arm64/x-scening.app/Contents/MacOS/x-scening'
      : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  ),
  args: process.env.OVERVIEW_SUMMARY_PACKAGED === '1' ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: temporary,
    OBSERVER_CONFIG: path.join(temporary, 'observer.yaml'),
  },
  timeout: 30000,
});
const results: string[] = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const overview = page.locator('.overview');
  const show = overview.getByRole('button', { name: '展示总结', exact: true });
  const date = page.getByLabel('选择日期');
  await page
    .getByRole('heading', { name: '这一天暂无活动', exact: true })
    .waitFor();
  assert.equal(await overview.locator('button').count(), 0);
  assert.equal(await overview.getByText('读取中', { exact: true }).count(), 0);
  results.push('T1 初始缺总结：按钮与读取提示隐藏');
  await date.fill(day);
  await show.waitFor();
  await page.screenshot({
    path: path.join(root, 'tmp/overview-summary-saved.png'),
  });
  const opening = await page.evaluate(async (response) => {
    const button = document.querySelector<HTMLButtonElement>(
      '.overview .daily-review-button',
    );
    if (!button) throw new Error('展示总结按钮缺失');
    const placeholders: string[] = [];
    const start = performance.now();
    return new Promise<{ milliseconds: number; placeholders: string[] }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error('等待完整档案超时'));
        }, 10000);
        const observer = new MutationObserver(() => {
          const placeholder = document.querySelector(
            'dialog .daily-summary-state',
          );
          if (placeholder) placeholders.push(placeholder.textContent ?? '');
          const prose = document.querySelector('dialog[open] .review-prose');
          if (prose?.textContent?.includes(response)) {
            observer.disconnect();
            clearTimeout(timeout);
            requestAnimationFrame(() => {
              resolve({
                milliseconds: performance.now() - start,
                placeholders,
              });
            });
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        button.click();
      },
    );
  }, response);
  await writeFile(
    path.join(
      evidence,
      process.env.OVERVIEW_SUMMARY_PACKAGED === '1'
        ? 'package-opening.json'
        : 'source-opening.json',
    ),
    JSON.stringify(opening, null, 2) + '\n',
  );
  assert.deepEqual(opening.placeholders, [], '已有档案直接呈现完整正文');
  const dialog = page.getByRole('dialog', { name: '当日档案', exact: true });
  await dialog.getByText(response, { exact: true }).waitFor();
  assert.equal(await readFile(target, 'utf8'), saved);
  assert.equal(await readFile(calls, 'utf8').catch(() => ''), '');
  await page.keyboard.press('Escape');
  results.push(
    `T2 已保存档案直接展示，过渡状态0次；点击到绘制${opening.milliseconds.toFixed(1)}ms，模型调用0次`,
  );
  await date.fill(empty);
  await show.waitFor({ state: 'hidden' });
  await page.screenshot({
    path: path.join(root, 'tmp/overview-summary-empty.png'),
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /测试预览.*使用标有/ }).click();
  await show.waitFor();
  await show.click();
  await dialog.getByText('【测试数据】', { exact: false }).first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /本地记录.*只读查看/ }).click();
  await show.waitFor({ state: 'hidden' });
  results.push('T4 切换来源展示对应测试报告，切回本地空日隐藏');
  await writeFile(
    path.join(home, 'daily-reviews', `${empty}.json`),
    JSON.stringify({
      day: empty,
      generatedAt: `${empty}T23:00:00+08:00`,
      sourceCount: 1,
      sourceHash: 'b'.repeat(64),
      response: '【测试数据】后来保存的总结。',
    }),
  );
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await show.waitFor();
  await rm(path.join(home, 'daily-reviews', `${empty}.json`));
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await show.waitFor({ state: 'hidden' });
  results.push('T5a 文件新增后刷新显示，报告移除后刷新隐藏');
  const emptyView = await page.evaluate(async (day) => {
    if (!window.observer) throw new Error('桌面接口缺失');
    return window.observer.readDailyReviewState({ day });
  }, empty);
  await app.evaluate(({ BrowserWindow }, view) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(
      'observer:daily-review-changed',
      view,
    );
  }, emptyView);
  const view = await page.evaluate(async (day) => {
    if (!window.observer) throw new Error('桌面接口缺失');
    return window.observer.readDailyReviewState({ day });
  }, day);
  await app.evaluate(({ ipcMain }, view) => {
    ipcMain.removeHandler('observer:daily-review-state');
    ipcMain.handle(
      'observer:daily-review-state',
      async (
        _event,
        query: Parameters<ObserverBridge['readDailyReviewState']>[0],
      ) => {
        if (query.day !== view.day) throw new Error('【测试数据】读取失败');
        await new Promise((resolve) => setTimeout(resolve, 800));
        return view;
      },
    );
  }, view);
  await date.fill(day);
  assert.equal(await overview.locator('button').count(), 0);
  await show.waitFor();
  await date.fill(empty);
  await show.waitFor({ state: 'hidden' });
  await date.fill(day);
  await date.fill(empty);
  await page.waitForTimeout(1200);
  assert.equal(await overview.locator('button').count(), 0);
  assert.equal(await date.inputValue(), empty);
  assert.equal(await overview.getByText('读取中', { exact: true }).count(), 0);
  results.push(
    'T3/T5b 延迟读取时隐藏、完成显示；快切空日及读取错误隔离旧日结果',
  );
  await date.fill(day);
  await show.waitFor();
  await app.evaluate(({ ipcMain }) => {
    let reads = 0;
    for (const channel of [
      'observer:day',
      'observer:task-timeline',
      'observer:daily-review-state',
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        reads++;
        throw new Error('【测试数据】已有档案读取故障注入');
      });
    }
    ipcMain.on(
      'test:summary-read-count',
      (_event, receive: (value: number) => void) => receive(reads),
    );
  });
  for (let i = 0; i < 3; i++) {
    await show.click();
    await dialog.getByText(response, { exact: true }).waitFor();
    assert.equal(await dialog.locator('.daily-summary-state').count(), 0);
    await page.keyboard.press('Escape');
  }
  const additionalReads = await app.evaluate(
    ({ ipcMain }) =>
      new Promise<number>((resolve) => {
        ipcMain.emit('test:summary-read-count', null, resolve);
      }),
  );
  assert.equal(additionalReads, 0);
  results.push('T7 已载入档案连续打开3次，额外读取0次，过渡状态0次');
  assert.equal(await readFile(target, 'utf8'), saved);
  assert.equal(await readFile(calls, 'utf8').catch(() => ''), '');
  assert.deepEqual(errors, []);
  const coverage = await page.coverage.stopJSCoverage();
  const packaged = process.env.OVERVIEW_SUMMARY_PACKAGED === '1';
  await writeFile(
    path.join(
      evidence,
      packaged ? 'package-coverage.json' : 'renderer-coverage.json',
    ),
    JSON.stringify(coverage),
  );
  const assets = path.join(evidence, 'coverage/renderer');
  await mkdir(assets, { recursive: true });
  for (const entry of coverage) {
    if (
      packaged ||
      !entry.url.startsWith('file:') ||
      !entry.url.includes('/out/renderer/assets/')
    )
      continue;
    const file = fileURLToPath(entry.url);
    await writeFile(
      path.join(assets, path.basename(file)),
      await readFile(file),
    );
    await writeFile(
      path.join(assets, path.basename(file) + '.map'),
      await readFile(file + '.map'),
    );
  }
  await writeFile(
    path.join(evidence, packaged ? 'package-e2e.json' : 'source-e2e.json'),
    JSON.stringify({ results, errors }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
