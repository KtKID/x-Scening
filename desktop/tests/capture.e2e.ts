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
import { localDay } from '../src/shared/protocol';
import { parseDocument } from 'yaml';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/desktop-capture');
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(evidence, 'home-'));
const home = path.join(temporary, 'home');
const day = localDay();
const target = path.join(home, `records/${day}.json`);
const fakePath = path.join(temporary, 'src/scening/observe_activity.py');
const fake = await readFile(
  path.join(desktop, 'tests/fixtures/capture.py'),
  'utf8',
);
await mkdir(path.join(home, 'records'), { recursive: true });
await mkdir(path.join(home, 'summaries'), { recursive: true });
await mkdir(path.join(temporary, '.venv/bin'), { recursive: true });
await mkdir(path.dirname(fakePath), { recursive: true });
await symlink(
  path.join(root, '.venv/bin/python'),
  path.join(temporary, '.venv/bin/python'),
);
await symlink(path.join(root, '.venv/lib'), path.join(temporary, '.venv/lib'));
await symlink(
  path.join(root, '.venv/pyvenv.cfg'),
  path.join(temporary, '.venv/pyvenv.cfg'),
);
await writeFile(
  path.join(path.dirname(fakePath), '__init__.py'),
  `__path__.append(${JSON.stringify(path.join(root, 'src/scening'))})`,
);
await writeFile(fakePath, fake);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', './home');
config.set('screenshotDir', './pictures');
config.setIn(['desktop', 'refreshIntervalSeconds'], 0.15);
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
const row = {
  start: `${day}T09:00:00+08:00`,
  end: `${day}T09:30:00+08:00`,
  app: 'Fixture App',
  analysis: '自动更新测试活动',
  screenshot: 'screen.png',
  mini: 'screen.png',
  source: 'screen',
};
await writeFile(target, JSON.stringify([row]));
const executable =
  process.env.OBSERVER_E2E_EXECUTABLE ??
  path.join(
    desktop,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  );
const results: { id: string; observed: string }[] = [];
const errors: string[] = [];
const timings: Record<string, number> = {};
let ownedPid: number | null = null;
const application = await electron.launch({
  executablePath: executable,
  args: [desktop],
  env: { ...process.env, OBSERVER_PROJECT_ROOT: temporary },
  timeout: 30000,
});
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('status').getByText('已停止', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开始截屏', exact: true }).click();
  await page.getByRole('status').getByText('采集中', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('选择日期').inputValue(), day);
  const cards = page.getByTestId('activity-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 1);
  await page.getByRole('button', { name: 'Fixture App', exact: true }).click();
  await cards.first().click();
  await page.getByRole('heading', { name: '活动详情', exact: true }).waitFor();
  const second = {
    ...row,
    start: `${day}T10:00:00+08:00`,
    end: `${day}T10:10:00+08:00`,
    analysis: '新落盘的第二条活动',
  };
  await writeFile(
    target,
    JSON.stringify([{ ...row, end: `${day}T09:45:00+08:00` }, second]),
  );
  await cards.nth(1).waitFor();
  await page
    .locator('.details .detail-time')
    .filter({ hasText: '09:00 — 09:45' })
    .waitFor();
  assert.ok(
    await page
      .getByRole('heading', { name: '活动详情', exact: true })
      .isVisible(),
  );
  assert.ok(
    await page
      .getByRole('button', { name: 'Fixture App', exact: true })
      .getAttribute('class')
      .then((value) => value?.includes('selected')),
  );
  const summary = {
    windowStart: `${day}T09:00:00+08:00`,
    windowEnd: `${day}T10:30:00+08:00`,
    generatedAt: `${day}T10:31:00+08:00`,
    timeline: [row, second],
    gaps: [],
    summary: '新落盘的自动更新总结',
    trigger: 'periodic',
  };
  await writeFile(
    path.join(home, `summaries/${day}.json`),
    JSON.stringify([summary]),
  );
  await page.getByRole('button', { name: '回顾', exact: true }).click();
  await page
    .locator('.summary-card')
    .getByText(summary.summary, { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await page.getByRole('button', { name: '前一天', exact: true }).click();
  await page
    .getByRole('heading', { name: '这一天暂无活动', exact: true })
    .waitFor();
  const previousDay = await page.getByLabel('选择日期').inputValue();
  await writeFile(target, JSON.stringify([row]));
  await page.waitForTimeout(400);
  assert.equal(await page.getByLabel('选择日期').inputValue(), previousDay);
  assert.equal(await cards.count(), 0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /测试预览.*使用标有/ }).click();
  await page.waitForTimeout(350);
  assert.equal(await cards.count(), 5);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  assert.equal(await cards.count(), 5);
  results.push({
    id: 'T4',
    observed:
      '新活动/末条end/总结自动更新；已选详情与筛选保留；选定历史日期及测试来源保持隔离；手动刷新保留。',
  });
  const analysisSwitch = page.getByRole('switch', {
    name: '开启分析',
    exact: true,
  });
  const beforeAnalysisToggle = await page.evaluate(() =>
    window.observer?.readRuntime(),
  );
  assert.ok(beforeAnalysisToggle && 'pid' in beforeAnalysisToggle.capture);
  const disablingBegan = performance.now();
  await analysisSwitch.click();
  await page
    .getByRole('switch', { name: '开启分析', checked: false })
    .waitFor();
  await page.getByRole('status').getByText('采集中', { exact: true }).waitFor();
  const captureOnly = await page.evaluate(() => window.observer?.readRuntime());
  assert.ok(captureOnly && 'pid' in captureOnly.capture);
  assert.equal(
    captureOnly.capture.pid,
    beforeAnalysisToggle.capture.pid,
    '窗口中关闭分析应保持原Python进程',
  );
  assert.equal(captureOnly.capture.mode, 'capture-only');
  timings.disableMs = performance.now() - disablingBegan;
  assert.ok(
    performance.now() - disablingBegan < 1000,
    '窗口中关闭分析应在1秒内确认完成',
  );
  assert.equal(await cards.count(), 5);
  await page.screenshot({ path: path.join(evidence, 'analysis-off.png') });
  const enablingBegan = performance.now();
  await analysisSwitch.click();
  await page.getByRole('switch', { name: '开启分析', checked: true }).waitFor();
  await page.getByRole('status').getByText('采集中', { exact: true }).waitFor();
  const full = await page.evaluate(() => window.observer?.readRuntime());
  assert.ok(full && 'pid' in full.capture);
  assert.equal(full.capture.mode, 'full');
  assert.equal(
    full.capture.pid,
    captureOnly.capture.pid,
    '窗口中开启分析应保持原Python进程',
  );
  assert.ok(
    performance.now() - enablingBegan < 1000,
    '窗口中开启分析应在1秒内确认完成',
  );
  timings.enableMs = performance.now() - enablingBegan;
  assert.equal(await cards.count(), 5);
  results.push({
    id: 'T10',
    observed:
      '真实Electron分析开关双向切换保持同一Python进程；仅截图/完整模式对应，测试卡片与数据来源保留。',
  });
  await page.setViewportSize({ width: 850, height: 720 });
  assert.ok(
    await page
      .getByRole('button', { name: '停止截屏', exact: true })
      .isVisible(),
  );
  assert.ok(await analysisSwitch.isVisible());
  const captureBox = await page
    .getByRole('button', { name: '停止截屏', exact: true })
    .boundingBox();
  const analysisBox = await analysisSwitch.boundingBox();
  assert.ok(captureBox && analysisBox);
  assert.ok(
    captureBox.x + captureBox.width <= analysisBox.x ||
      analysisBox.x + analysisBox.width <= captureBox.x ||
      captureBox.y + captureBox.height <= analysisBox.y ||
      analysisBox.y + analysisBox.height <= captureBox.y,
  );
  await page.screenshot({ path: path.join(evidence, 'narrow-running.png') });
  await writeFile(path.join(home, 'control-delay'), '.25');
  await analysisSwitch.click();
  const stopButton = page.getByRole('button', {
    name: '停止截屏',
    exact: true,
  });
  assert.ok(await stopButton.isEnabled(), '分析切换期间停止截屏保持可用');
  const stoppingBegan = performance.now();
  await stopButton.click();
  await page.getByRole('status').getByText('已停止', { exact: true }).waitFor();
  timings.stopDuringSwitchMs = performance.now() - stoppingBegan;
  assert.ok(timings.stopDuringSwitchMs < 1000, '切换中停止应在1秒内实际完成');
  await page.waitForTimeout(300);
  assert.equal(
    (await page.evaluate(() => window.observer?.readRuntime()))?.capture.state,
    'stopped',
  );
  await rm(path.join(home, 'control-delay'));
  await writeFile(
    fakePath,
    "print('测试启动失败',flush=True)\nraise SystemExit(2)\n",
  );
  await page.getByRole('button', { name: '开始截屏', exact: true }).click();
  await page
    .getByRole('status')
    .getByText('采集异常', { exact: true })
    .waitFor();
  assert.ok(
    (await page.locator('.capture-progress').textContent())?.includes(
      '测试启动失败',
    ),
  );
  await writeFile(fakePath, fake);
  await page.getByRole('button', { name: '开始截屏', exact: true }).click();
  await page.getByRole('status').getByText('采集中', { exact: true }).waitFor();
  ownedPid = await page.evaluate(async () => {
    const state = await window.observer?.readRuntime();
    return state && 'pid' in state.capture ? state.capture.pid : null;
  });
  assert.ok(ownedPid);
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.screenshot({ path: path.join(evidence, 'running.png') });
  results.push({
    id: 'T5',
    observed:
      '真实Electron按钮启动实际受控Python进程；停止中→已停止；退出码2可见且重试恢复；850px控件可见。屏幕和模型由测试模块替代。',
  });
  assert.equal(await readFile(target, 'utf8'), JSON.stringify([row]));
  assert.deepEqual(errors, []);
} finally {
  await application.close();
  const exitedPid = ownedPid;
  if (exitedPid) assert.throws(() => process.kill(exitedPid, 0));
  await rm(temporary, { recursive: true, force: true });
}
results.push({
  id: 'T5-quit',
  observed: '退出应用后本客户端启动的采集进程已回收；正式记录只读保持。',
});
await writeFile(
  path.join(root, 'reports/fix/analysis-control-20261028/electron.json'),
  JSON.stringify({ results, errors, timings }, null, 2),
);
console.log(JSON.stringify({ results, errors, timings }, null, 2));
