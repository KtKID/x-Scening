import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDay } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/default-local/client');
await mkdir(evidence, { recursive: true });
await mkdir(path.join(root, 'reports/default-local-20261029'), {
  recursive: true,
});
const temporary = await mkdtemp(path.join(evidence, 'e2e-home-'));
const home = path.join(temporary, 'home');
const day = localDay();
await mkdir(path.join(home, 'records'), { recursive: true });
await mkdir(path.join(home, 'summaries'), { recursive: true });
await mkdir(path.join(home, 'images'), { recursive: true });
await writeFile(
  path.join(temporary, 'observer.yaml'),
  'home: ./home\nscreenshotDir: ./snapshots\n',
);
const target = path.join(home, `records/${day}.json`);
const row = {
  start: `${day}T09:00:00+08:00`,
  end: `${day}T09:30:00+08:00`,
  app: 'Fixture App',
  analysis: '本地只读验证活动。完整正文用于确认详情切换。',
  screenshot: 'images/screen.png',
  mini: 'images/screen.png',
  source: 'screen',
};
const dense = {
  ...row,
  start: `${day}T09:00:01+08:00`,
  end: `${day}T09:00:01+08:00`,
  analysis: '单时间点活动',
};
const original = JSON.stringify([row, dense]);
await writeFile(target, original);
await writeFile(
  path.join(home, 'images/screen.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8f28rAzbAhFV00EoAAPfdApLUYjL3AAAAAElFTkSuQmCC',
    'base64',
  ),
);
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
const results: { id: string; observed: string }[] = [];
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
  await page.getByRole('heading', { name: '当日概览', exact: true }).waitFor();
  assert.equal(
    (await page.locator('.source-badge').textContent())?.trim(),
    '本地记录',
  );
  await page
    .getByRole('button', { name: 'Fixture App', exact: true })
    .waitFor();
  assert.equal(await page.getByTestId('activity-card').count(), 2);
  assert.equal(
    (await page.locator('.workspace-body').innerText()).includes(
      '【测试数据】',
    ),
    false,
  );
  results.push({
    id: 'T0',
    observed: '启动默认本地记录，读取2条隔离文件活动；真实列表保留原文。',
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /测试预览.*使用标有/ }).click();
  const cards = page.getByTestId('activity-card');
  assert.equal(await cards.count(), 5);
  const settingsBox = await page
    .getByRole('button', { name: '设置', exact: true })
    .boundingBox();
  const hintBox = await page.locator('.inspector-hint').boundingBox();
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  assert.ok(settingsBox && hintBox && viewport);
  assert.ok(settingsBox.y + settingsBox.height <= viewport.height);
  assert.ok(hintBox.y + hintBox.height <= viewport.height);
  for (const title of await cards.locator('h3').allTextContents())
    assert.ok(title.startsWith('【测试数据】'));
  for (const text of await cards.locator('p').allTextContents())
    assert.ok(text.startsWith('【测试数据】'));
  await page.screenshot({ path: path.join(evidence, 'overview.png') });
  await cards.first().click();
  await page.getByRole('heading', { name: '活动详情', exact: true }).waitFor();
  await page.getByText('【测试数据】截图占位', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'details.png') });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('heading', { name: '当日概览', exact: true }).waitFor();
  results.push({
    id: 'T5',
    observed:
      '真实Electron手动选择测试预览后显示5张测试卡片；标题和正文均以测试标识开头；点击显示详情和测试截图占位，关闭恢复概览。',
  });

  await page.getByRole('button', { name: 'Chrome', exact: true }).click();
  assert.equal(await cards.count(), 2);
  await page.getByRole('button', { name: '全部应用', exact: true }).click();
  await page.getByRole('button', { name: '前一天', exact: true }).click();
  assert.notEqual(await page.getByLabel('选择日期').inputValue(), day);
  await page.getByRole('button', { name: '后一天', exact: true }).click();
  assert.equal(await page.getByLabel('选择日期').inputValue(), day);
  await page.getByLabel('选择日期').fill('2026-01-02');
  await page.getByRole('heading', { name: '1月2日', exact: true }).waitFor();
  await page.getByRole('button', { name: '今天', exact: true }).click();
  assert.equal(await page.getByLabel('选择日期').inputValue(), day);
  await page
    .locator('.sidebar')
    .getByRole('button', { name: '回顾', exact: true })
    .click();
  await page.getByRole('heading', { name: '活动总结', exact: true }).waitFor();
  await page
    .locator('.summary-card')
    .filter({ hasText: '【测试数据】' })
    .waitFor();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await page.setViewportSize({ width: 850, height: 720 });
  await cards.first().click();
  await page.getByRole('heading', { name: '活动详情', exact: true }).waitFor();
  assert.equal(
    await page.locator('.inspector.has-selection').isVisible(),
    true,
  );
  await page.screenshot({ path: path.join(evidence, 'narrow-details.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 940 });
  results.push({
    id: 'T6',
    observed:
      'Chrome筛选为2条；前后日期、日历与今天成功；总结有测试标识；850px窗口的详情抽屉可见，Escape关闭。',
  });

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /本地记录.*只读查看/ }).click();
  await page
    .getByRole('button', { name: 'Fixture App', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Fixture App', exact: true }).click();
  await writeFile(target, JSON.stringify([{ ...row, app: 'Other App' }]));
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page
    .getByRole('heading', { name: '当前筛选暂无活动', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '全部应用', exact: true }).click();
  assert.equal(await cards.count(), 1);
  await writeFile(target, original);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page
    .getByRole('button', { name: 'Fixture App', exact: true })
    .waitFor();
  const raceSafe = await page.evaluate(async (selectedDay) => {
    const observer = window.observer;
    if (!observer) return false;
    const [local] = await Promise.all([
      observer.readDay({ day: selectedDay, source: 'local' }),
      observer.readDay({ day: selectedDay, source: 'demo' }),
    ]);
    const image = await observer.readImage(local.activities[0]?.id ?? '');
    return image.status === 'missing';
  }, day);
  assert.equal(raceSafe, true);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page
    .getByRole('button', { name: 'Fixture App', exact: true })
    .waitFor();
  assert.equal(await cards.count(), 2);
  assert.ok((await cards.first().textContent())?.includes('本地只读验证活动'));
  const boxes = await cards.all();
  const firstBox = await boxes[0]?.boundingBox();
  const secondBox = await boxes[1]?.boundingBox();
  assert.ok(
    firstBox && secondBox && secondBox.y >= firstBox.y + firstBox.height,
  );
  await cards.first().click();
  await page
    .getByRole('img', { name: '活动对应的原始截图', exact: true })
    .waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.screenshot-box img');
    return (
      image instanceof HTMLImageElement &&
      image.complete &&
      image.naturalWidth > 0
    );
  });
  await page.getByRole('button', { name: '放大截图', exact: true }).click();
  await page.getByRole('dialog', { name: '截图预览', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭截图预览', exact: true }).click();
  assert.equal(await readFile(target, 'utf8'), original);
  await writeFile(
    target,
    JSON.stringify([{ ...row, end: `${day}T09:45:00+08:00` }, dense]),
  );
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await cards.first().getByText('09:00 — 09:45', { exact: true }).waitFor();
  await page.getByRole('button', { name: '前一天', exact: true }).click();
  await page
    .getByRole('heading', { name: '这一天暂无活动', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await page
    .getByRole('button', { name: 'Fixture App', exact: true })
    .waitFor();
  await writeFile(target, '{broken');
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '活动读取失败' }).waitFor();
  await writeFile(target, original);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page
    .getByRole('button', { name: 'Fixture App', exact: true })
    .waitFor();
  results.push({
    id: 'T7',
    observed:
      '真实IPC读取隔离home中的2条记录及PNG；同小时点记录顺序排列；放大截图可打开与关闭；只读前后文件一致；外部延长end后刷新更新；空日、坏JSON提示及修复后刷新恢复成功。',
  });
  const paths = await application.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    sandboxed: app
      .getAppMetrics()
      .filter((metric) => metric.type === 'Tab')
      .map((metric) => metric.sandboxed),
  }));
  assert.ok(paths.userData.startsWith(temporary));
  assert.ok(paths.sandboxed.length > 0 && paths.sandboxed.every(Boolean));
  assert.equal(await page.evaluate(() => typeof process), 'undefined');
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  assert.deepEqual(errors, []);
  results.push({
    id: 'T8',
    observed:
      'userData位于项目tmp下独占验证目录，Tab进程报告OS沙箱启用，页面process/require均为undefined，页面异常0；contextIsolation配置另外通过源码核对。',
  });
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
await writeFile(
  path.join(root, 'reports/default-local-20261029/client-e2e.json'),
  JSON.stringify(
    { platform: process.platform, day, results, errors, count: results.length },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ count: results.length, results, errors }, null, 2),
);
