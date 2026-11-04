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
import { localDay, moveDay } from '../src/shared/protocol';
import { DailyReviewStateSchema } from '../src/shared/scening.generated';
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/daily-review-automation');
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(evidence, 'electron-'));
const home = path.join(temporary, 'home');
const today = localDay();
const yesterday = moveDay(today, -1);
const older = moveDay(today, -2);
const errors: string[] = [];
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
config.setIn(['dailyReview', 'checkIntervalSeconds'], 0.2);
const launcher = path.join(temporary, 'model.mjs');
await writeFile(
  launcher,
  `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(path.join(temporary, 'calls.txt'))},'call\\n'); setTimeout(()=>process.stdout.write('已结束日期的十二小时分析也已生成完整总结，其他时段保持待确认。'),400);`,
);
config.set('kmhLauncher', launcher);
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
for (const day of [yesterday, older])
  await writeFile(
    path.join(home, 'summaries', `${day}.json`),
    JSON.stringify([
      {
        windowStart: `${day}T00:00:00+08:00`,
        windowEnd: `${day}T12:00:00+08:00`,
        generatedAt: `${day}T12:01:00+08:00`,
        summary: '只有十二小时已保存分析，其余待分析。',
        timeline: [],
        gaps: [],
      },
    ]),
  );
const fullError = `真实连接错误开头\n${'多行服务响应详情'.repeat(700)}\n真实错误结尾`;
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
      message: fullError,
      details: fullError,
    },
  }),
);
const app = await electron.launch({
  executablePath:
    process.env.DAILY_REVIEW_PACKAGE_PATH ??
    path.join(
      desktop,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ),
  args: process.env.DAILY_REVIEW_PACKAGE_PATH ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: temporary,
    OBSERVER_CONFIG: path.join(temporary, 'observer.yaml'),
  },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page
    .getByRole('dialog', { name: '当日档案', exact: true })
    .getByText(
      '已结束日期的十二小时分析也已生成完整总结，其他时段保持待确认。',
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByLabel('选择日期').inputValue(), today);
  assert.equal(await page.locator('.daily-center-summary').count(), 0);
  assert.equal(await page.locator('.daily-archive-sheet').count(), 0);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const time = page.getByLabel('自动生成时间', { exact: true });
  assert.equal(await time.getAttribute('type'), 'time');
  await time.fill('04:15');
  await page
    .locator('.settings-editor')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await page
    .getByText('设置已保存。每日总结时间立即生效，采集参数下次开始时生效。')
    .waitFor();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '回顾', exact: true })
    .click();
  await page.getByRole('tab', { name: '每日总结', exact: true }).click();
  await page.getByLabel('选择日期').fill(today);
  assert.equal(await page.getByLabel('选择日期').inputValue(), today);
  await page
    .locator('.daily-pending-message')
    .getByText(`${Number(today.slice(-2))}号结束后会在第二天自动总结`, {
      exact: false,
    })
    .waitFor();
  assert.equal(await page.locator('.daily-center-summary').count(), 1);
  await page.getByLabel('选择日期').fill(older);
  await page
    .locator('.daily-error-details')
    .getByText(fullError, { exact: true })
    .waitFor();
  assert.equal(await page.locator('.daily-center-summary').isVisible(), true);
  await page.screenshot({
    path: path.join(evidence, 'full-error-and-summary.png'),
  });
  await page.locator('.daily-center-summary').click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('选择日期').fill(today);
  // 等待旧日期的真实提交完成，再确认迟到结果保持原日期归属。
  for (let index = 0; index < 100; index++) {
    const ready = await readFile(
      path.join(home, 'daily-reviews', `${older}.json`),
      'utf8',
    ).catch(() => '');
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await page.getByLabel('选择日期').inputValue(), today);
  await page
    .locator('.daily-pending-message')
    .getByText(`${Number(today.slice(-2))}号结束后会在第二天自动总结`, {
      exact: false,
    })
    .waitFor();
  await page
    .getByRole('dialog')
    .getByText(
      '已结束日期的十二小时分析也已生成完整总结，其他时段保持待确认。',
      { exact: true },
    )
    .waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('选择日期').fill(older);
  await page
    .locator('.daily-archive-sheet')
    .getByText(
      '已结束日期的十二小时分析也已生成完整总结，其他时段保持待确认。',
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.locator('.daily-error-details').count(), 0);
  assert.equal(await page.locator('.daily-center-summary').count(), 0);
  await page.screenshot({ path: path.join(evidence, 'completed-report.png') });
  await page.keyboard.press('Escape');
  const state = DailyReviewStateSchema.parse(
    JSON.parse(
      await readFile(
        path.join(home, 'daily-review-status', `${yesterday}.json`),
        'utf8',
      ),
    ),
  );
  assert.equal(state.presentedOn, today);
  const callsBefore = await readFile(path.join(temporary, 'calls.txt'), 'utf8');
  await page.close();
  const nextWindow = app.waitForEvent('window');
  await app.evaluate(({ app: desktopApp }) => {
    desktopApp.emit('activate');
  });
  const reopened = await nextWindow;
  reopened.on('pageerror', (error) => errors.push(error.message));
  await reopened.getByLabel('选择日期').waitFor();
  const resumeListeners = await app.evaluate(({ powerMonitor }) => {
    const count = powerMonitor.listenerCount('resume');
    powerMonitor.emit('resume');
    return count;
  });
  assert.ok(resumeListeners > 0);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(await reopened.getByLabel('选择日期').inputValue(), today);
  assert.equal(
    await readFile(path.join(temporary, 'calls.txt'), 'utf8'),
    callsBefore,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, 'reports/daily-review-automation/electron-e2e.json'),
    JSON.stringify(
      {
        results: [
          '首次打开自动生成昨日并弹窗展示，保留页面日期',
          '时间选择组件及真实保存',
          '当天生成按钮和自动总结日期提示',
          '历史失败完整可见与居中总结单次恢复',
          '迟到结果保持原日期归属',
          '展示回执持久化',
          '关闭窗口后主进程保留，重开保持当日且报告展示一次',
          '实际Electron resume回调与重复生成保护',
        ],
        errors,
        screenshots: [
          'tmp/daily-review-automation/full-error-and-summary.png',
          'tmp/daily-review-automation/completed-report.png',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
