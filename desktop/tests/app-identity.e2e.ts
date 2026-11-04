import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { localDay } from '../src/shared/protocol';

const desktop = path.resolve(import.meta.dirname, '..');
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/app-identity-client');
const report = path.join(root, 'reports/cr/evidence/app-identity-20261029');
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(evidence, 'window-'));
const day = localDay();
const target = path.join(temporary, `home/records/${day}.json`);
await mkdir(path.dirname(target), { recursive: true });
await mkdir(path.join(temporary, 'home/summaries'), { recursive: true });
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', './home');
config.set('screenshotDir', './pictures');
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
await writeFile(
  path.join(temporary, 'home/screen.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8f28rAzbAhFV00EoAAPfdApLUYjL3AAAAAElFTkSuQmCC',
    'base64',
  ),
);
const base = {
  app: 'Stale Captured App',
  screenshot: 'screen.png',
  mini: 'screen.png',
  source: 'screen',
  observation: {
    schema_version: 1,
    visible_activity: '【验证数据】检查应用来源。',
    inferred_intent: '【验证数据】验证。',
    stage_and_evidence: '【验证数据】待确认。',
    app_tags: ['Wrong Model App'],
    task_types: ['工作'],
  },
};
const rows = [
  {
    ...base,
    start: `${day}T09:00:00+08:00`,
    end: `${day}T09:00:40+08:00`,
    analysis: '可见事实：【验证数据】混合应用来源。',
    frames: ['Google Chrome', 'ChatGPT', 'Google Chrome'].map((app, index) => ({
      app,
      bundleId:
        app === 'Google Chrome' ? 'com.google.Chrome' : 'com.openai.codex',
      capturedAt: `${day}T09:00:${String(index * 20).padStart(2, '0')}+08:00`,
      screenshot: 'screen.png',
      screen: index === 2 ? 2 : 1,
    })),
  },
  {
    ...base,
    start: `${day}T09:01:00+08:00`,
    end: `${day}T09:01:00+08:00`,
    analysis: '可见事实：【验证数据】未知身份。',
    frames: [
      {
        app: null,
        capturedAt: `${day}T09:01:00+08:00`,
        screenshot: 'screen.png',
        screen: 2,
      },
    ],
  },
  {
    ...base,
    app: 'Legacy App',
    start: `${day}T09:02:00+08:00`,
    end: `${day}T09:02:00+08:00`,
    analysis: '可见事实：【验证数据】旧单图兼容。',
  },
];
const original = JSON.stringify(rows);
await writeFile(target, original);
await writeFile(
  path.join(temporary, `home/summaries/${day}.json`),
  JSON.stringify([
    {
      windowStart: `${day}T09:00:00+08:00`,
      windowEnd: `${day}T09:30:00+08:00`,
      generatedAt: `${day}T09:31:00+08:00`,
      timeline: [
        {
          start: rows[0]?.start,
          end: rows[0]?.end,
          app: 'Google Chrome、ChatGPT',
          analysis: '【验证数据】混合应用活动。',
        },
      ],
      gaps: [],
      summary: '【验证数据】系统采集应用：Google Chrome、ChatGPT。',
      trigger: 'periodic',
    },
  ]),
);
const executable = path.join(
  desktop,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);
const application = await electron.launch({
  executablePath: executable,
  args: [desktop],
  env: { ...process.env, OBSERVER_PROJECT_ROOT: temporary },
  timeout: 30000,
});
const errors: string[] = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  const cards = page.getByTestId('activity-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 3);
  assert.deepEqual(
    await cards.locator('.card-metadata > span').allTextContents(),
    ['Google Chrome、ChatGPT', '未知应用', 'Legacy App'],
  );
  assert.deepEqual(
    await page.locator('.day-metrics strong').allTextContents(),
    ['3', '3'],
  );
  assert.equal(await page.getByText('Wrong Model App').count(), 0);
  assert.equal(await page.getByText('Stale Captured App').count(), 0);
  assert.deepEqual(
    await page.locator('.app-distribution > span').allTextContents(),
    ['Google Chrome', 'ChatGPT', '未知应用', 'Legacy App'],
  );
  assert.deepEqual(
    await page.locator('.app-distribution > small').allTextContents(),
    ['1条', '1条', '1条', '1条'],
  );
  await page
    .getByRole('button', { name: 'Google Chrome', exact: true })
    .click();
  assert.equal(await cards.count(), 1);
  await page.getByRole('button', { name: 'ChatGPT', exact: true }).click();
  assert.equal(await cards.count(), 1);
  await cards.first().click();
  assert.equal(
    await page.locator('.detail-app > span').textContent(),
    'Google Chrome、ChatGPT',
  );
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '未知应用', exact: true }).click();
  assert.equal(await cards.count(), 1);
  await page.getByRole('button', { name: 'Legacy App', exact: true }).click();
  assert.equal(await cards.count(), 1);
  await page.getByRole('button', { name: '全部应用', exact: true }).click();
  assert.equal(await cards.count(), 3);
  await page.screenshot({ path: path.join(evidence, 'overview.png') });
  await page
    .locator('.sidebar')
    .getByRole('button', { name: '回顾', exact: true })
    .click();
  assert.ok(
    (await page.locator('.summary-card').innerText()).includes(
      'Google Chrome、ChatGPT',
    ),
  );
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  assert.equal(await cards.count(), 3);
  await page.setViewportSize({ width: 850, height: 720 });
  await cards.first().click();
  assert.equal(
    await page.locator('.detail-app > span').textContent(),
    'Google Chrome、ChatGPT',
  );
  await page.screenshot({ path: path.join(evidence, 'narrow-detail.png') });
  assert.equal(await readFile(target, 'utf8'), original);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(report, 'client-fixed.json'),
    JSON.stringify(
      {
        passed: true,
        cards: 3,
        apps: 3,
        distributionGroupsIncludingUnknown: 4,
        mixedActivityMatchesBothFilters: true,
        perApplicationActivityCounts: [1, 1, 1, 1],
        unknownPreserved: true,
        legacyReadable: true,
        modelAppsIgnored: true,
        staleTopLevelIgnoredWhenFramesPresent: true,
        summaryDisplayed: true,
        detailAndRefresh: true,
        narrowWidth: 850,
        sourceReadOnly: true,
        pageErrors: errors,
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: 卡片、详情、两应用筛选、逐应用统计、总结、未知与旧记录、刷新和窄窗口。',
  );
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
