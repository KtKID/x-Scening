import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
import { localDay, moveDay } from '../src/shared/protocol';
import {
  DailyReviewStateSchema,
  DailyReviewSchema,
} from '../src/shared/scening.generated';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(
  root,
  'reports/fix/daily-review-dialog-20261104/evidence',
);
await mkdir(evidence, { recursive: true });
await mkdir(path.join(root, 'tmp'), { recursive: true });
await mkdir(path.join(root, 'logs'), { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/daily-dialog-'));
const home = path.join(temporary, 'home');
const day = moveDay(localDay(), -1);
const older = moveDay(day, -1);
const stateFile = path.join(home, 'daily-review-status', `${day}.json`);
const readState = async () =>
  DailyReviewStateSchema.parse(JSON.parse(await readFile(stateFile, 'utf8')));
const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待隔离日报告状态超时');
};
await mkdir(path.join(home, 'summaries'), { recursive: true });
await mkdir(path.join(home, 'daily-review-status'), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temporary, '.venv'));
await symlink(path.join(root, 'src'), path.join(temporary, 'src'));
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', home);
config.set('screenshotDir', path.join(temporary, 'snapshots'));
config.setIn(['dailyReview', 'scheduledTime'], '00:00');
config.setIn(['dailyReview', 'checkIntervalSeconds'], 0.5);
const launcher = path.join(temporary, 'model.mjs');
const modeFile = path.join(temporary, 'mode.txt');
const countFile = path.join(temporary, 'calls.txt');
await writeFile(modeFile, 'OK');
await writeFile(
  launcher,
  `import {appendFileSync,readFileSync} from 'node:fs';appendFileSync(${JSON.stringify(countFile)},'call\\n');const fail=readFileSync(${JSON.stringify(modeFile)},'utf8')==='FAIL';setTimeout(()=>{if(fail){process.stderr.write('完整错误：隔离测试模型连接失败\\n保留多行详情');process.exit(2);}process.stdout.write('【测试数据】统一弹窗流程的完整日报告。');},1200);`,
);
config.set('kmhLauncher', launcher);
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
for (const selected of [day, older]) {
  await writeFile(
    path.join(home, 'summaries', `${selected}.json`),
    JSON.stringify([
      {
        windowStart: `${selected}T09:00:00+08:00`,
        windowEnd: `${selected}T09:30:00+08:00`,
        generatedAt: `${selected}T09:31:00+08:00`,
        summary: '【测试数据】统一弹窗验证资料。',
        timeline: [],
        gaps: [],
      },
    ]),
  );
}
await writeFile(
  path.join(home, 'daily-review-status', `${older}.json`),
  JSON.stringify({
    schemaVersion: 1,
    day: older,
    phase: 'failed',
    autoAttempts: 3,
    autoExhausted: true,
    lastError: {
      source: 'model',
      occurredAt: new Date().toISOString(),
      message: '此前失败',
      details: '此前失败',
    },
  }),
);
const executable = process.env.DAILY_REVIEW_PACKAGE_PATH;
const app = await electron.launch({
  executablePath:
    executable ??
    path.join(
      desktop,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ),
  args: executable ? [] : [desktop],
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
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.hide(),
  );
  await until(async () => (await readState()).phase === 'succeeded');
  assert.equal((await readState()).presentedOn, null);
  results.push('自动后台生成成功，隐藏窗口保留待展示标记');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  const dialog = page.getByRole('dialog', { name: '当日档案', exact: true });
  await dialog.waitFor();
  await dialog
    .getByText('【测试数据】统一弹窗流程的完整日报告。', { exact: true })
    .waitFor();
  await until(async () => (await readState()).presentedOn === localDay());
  assert.equal(await page.getByLabel('选择日期').inputValue(), localDay());
  assert.equal(await page.locator('.daily-archive-sheet').count(), 0);
  await page.screenshot({
    path: path.join(root, 'tmp/daily-dialog-automatic.png'),
  });
  results.push('回到前台实际显示统一弹窗后写回执，保留原页面日期');
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.blur();
    window?.focus();
  });
  await page.waitForTimeout(800);
  assert.equal(await dialog.count(), 0);
  results.push('同日再次聚焦保持当前页面');

  await page.getByLabel('选择日期').fill(day);
  await page
    .locator('.overview')
    .getByRole('button', { name: '展示总结', exact: true })
    .click();
  await dialog.waitFor();
  await dialog
    .getByText('【测试数据】统一弹窗流程的完整日报告。', { exact: true })
    .waitFor();
  results.push('右侧展示总结按钮读取已有报告并进入相同弹窗');
  await dialog.getByRole('button', { name: '重新生成', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^(回顾|总结)$/, exact: true })
    .click();
  await page.getByRole('tab', { name: '每日总结', exact: true }).click();
  const sheet = page.locator('.daily-archive-sheet');
  await sheet
    .getByText('【测试数据】统一弹窗流程的完整日报告。', { exact: true })
    .waitFor();
  assert.equal(await page.locator('dialog').count(), 0);
  await sheet.getByRole('button', { name: '重新生成', exact: true }).click();
  await dialog.getByRole('button', { name: '总结中', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '重新生成', exact: true }).waitFor();
  assert.equal(await dialog.count(), 1);
  results.push('每日页直接显示已有正文，重新生成复用同一个弹窗');
  await page.keyboard.press('Escape');

  await page.getByLabel('选择日期').fill(older);
  await page.locator('.daily-center-summary').click();
  await dialog.waitFor();
  await dialog
    .getByText('【测试数据】统一弹窗流程的完整日报告。', { exact: true })
    .waitFor();
  assert.equal(await dialog.count(), 1);
  await writeFile(modeFile, 'FAIL');
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  await dialog
    .locator('.daily-error-details')
    .getByText('完整错误：隔离测试模型连接失败', { exact: false })
    .waitFor();
  assert.equal(await dialog.locator('.review-prose').count(), 1);
  await writeFile(modeFile, 'OK');
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  await dialog.getByRole('button', { name: '重新生成', exact: true }).waitFor();
  assert.equal(await dialog.locator('.daily-error-details').count(), 0);
  await page.screenshot({
    path: path.join(root, 'tmp/daily-dialog-manual.png'),
  });
  results.push('每日页生成、失败保留正文、完整错误及手动重试共用弹窗');
  await page.keyboard.press('Escape');

  const state = await readState();
  await writeFile(stateFile, JSON.stringify({ ...state, presentedOn: null }));
  const view = await page.evaluate(async (day) => {
    if (!window.observer) throw new Error('桌面接口缺失');
    return window.observer.readDailyReviewState({ day });
  }, day);
  await app.evaluate(({ BrowserWindow }, view) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.hide();
    window?.webContents.send('observer:daily-review-open', view);
  }, view);
  await page.waitForTimeout(900);
  assert.equal((await readState()).presentedOn, null);
  const rejected = await page.evaluate(async (view) => {
    if (!window.observer) throw new Error('桌面接口缺失');
    return window.observer.markDailyReviewPresented({
      day: view.day,
      homeId: view.homeId,
      revision: view.revision,
    });
  }, view);
  assert.equal(rejected.presentedOn, null);
  results.push('隐藏时迟到自动事件和直接回执均保留待展示状态');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  await dialog.waitFor();
  await until(async () => (await readState()).presentedOn === localDay());
  await page.keyboard.press('Escape');
  results.push('隐藏后返回前台恢复弹窗并持久确认');
  await writeFile(
    stateFile,
    JSON.stringify({ ...(await readState()), presentedOn: null }),
  );
  const lockedView = await page.evaluate(async (day) => {
    if (!window.observer) throw new Error('桌面接口缺失');
    return window.observer.readDailyReviewState({ day });
  }, day);
  await app.evaluate(({ BrowserWindow, powerMonitor }, view) => {
    powerMonitor.emit('lock-screen');
    BrowserWindow.getAllWindows()[0]?.webContents.send(
      'observer:daily-review-open',
      view,
    );
  }, lockedView);
  await page.waitForTimeout(700);
  assert.equal((await readState()).presentedOn, null);
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('unlock-screen');
  });
  await until(async () => (await readState()).presentedOn === localDay());
  results.push('锁屏期间回执延后，解锁后实际显示才确认');
  const olderView = await page.evaluate(async (day) => {
    if (!window.observer) throw new Error('桌面接口缺失');
    return window.observer.readDailyReviewState({ day });
  }, older);
  await app.evaluate(({ BrowserWindow }, view) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(
      'observer:daily-review-open',
      view,
    );
  }, olderView);
  await page.waitForTimeout(300);
  assert.equal(
    await dialog.locator('.archive-date-tab').textContent(),
    day.replaceAll('-', ' · '),
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor();
  assert.equal(
    await dialog.locator('.archive-date-tab').textContent(),
    older.replaceAll('-', ' · '),
  );
  await page.keyboard.press('Escape');
  results.push('多个报告按日期排队并复用同一个弹窗');
  const explicit = await page.evaluate(async (day) => {
    if (!window.observer) throw new Error('桌面接口缺失');
    return window.observer.readDailyReview({
      day,
      source: 'local',
      refresh: true,
    });
  }, day);
  assert.equal(explicit.status, 'ready');
  await dialog.waitFor();
  await dialog
    .getByText('【测试数据】统一弹窗流程的完整日报告。', { exact: true })
    .waitFor();
  assert.equal(await page.locator('dialog:modal').count(), 1);
  await page.keyboard.press('Escape');
  results.push('公开显式生成入口也通知同一个档案弹窗');
  const report = DailyReviewSchema.parse(
    JSON.parse(
      await readFile(path.join(home, 'daily-reviews', `${day}.json`), 'utf8'),
    ),
  );
  assert.equal(report.day, day);
  assert.deepEqual(errors, []);
  const coverage = await page.coverage.stopJSCoverage();
  await writeFile(
    path.join(evidence, 'renderer-coverage.json'),
    JSON.stringify(coverage),
  );
  if (!executable) {
    const assets = path.join(evidence, 'coverage/renderer');
    await mkdir(assets, { recursive: true });
    for (const entry of coverage) {
      if (
        !entry.url.startsWith('file:') ||
        !entry.url.includes('/out/renderer/assets/')
      )
        continue;
      const file = fileURLToPath(entry.url);
      await writeFile(
        path.join(assets, path.basename(file)),
        await readFile(file),
      );
      if (existsSync(file + '.map'))
        await writeFile(
          path.join(assets, path.basename(file) + '.map'),
          await readFile(file + '.map'),
        );
    }
    await writeFile(
      path.join(evidence, 'source-renderer-coverage.json'),
      JSON.stringify(coverage),
    );
  }
  await writeFile(
    path.join(evidence, executable ? 'package-e2e.json' : 'source-e2e.json'),
    JSON.stringify(
      { results, errors, finalState: await readState() },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
