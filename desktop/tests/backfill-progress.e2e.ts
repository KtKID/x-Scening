import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  fixture,
  callCount,
  eventually,
  root,
  desktop,
} from './backfill-fixture';
import { localDay, moveDay } from '../src/shared/protocol';

const f = await fixture();
const day = localDay();
for (const name of await readdir(f.shots))
  await rename(
    path.join(f.shots, name),
    path.join(f.shots, name.replace(f.day, day)),
  );
const report = path.join(root, 'reports/backfill-progress-20261031');
const preview = path.join(root, 'tmp/backfill-progress-preview');
await mkdir(report, { recursive: true });
await mkdir(preview, { recursive: true });
const packaged = process.env.BACKFILL_PACKAGED === '1';
const results: string[] = [];
const errors: string[] = [];
const application = await electron.launch({
  executablePath: path.join(
    desktop,
    packaged
      ? 'release/mac-arm64/x-scening.app/Contents/MacOS/x-scening'
      : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  ),
  args: packaged ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: f.folder,
    OBSERVER_CONFIG: f.configPath,
  },
});
try {
  let page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  if (
    (await page
      .getByRole('switch', { name: '开启分析' })
      .getAttribute('aria-checked')) === 'true'
  ) {
    await page.getByRole('switch', { name: '开启分析' }).click();
    await page
      .getByRole('switch', { name: '开启分析', checked: false })
      .waitFor();
  }
  await page.getByRole('button', { name: '整理', exact: true }).click();
  const panel = () => page.getByRole('region', { name: '补分析页面' });
  const progress = () =>
    panel().getByRole('progressbar', { name: '截图分析进度' });
  await panel().getByLabel('补分析日期').fill(day);
  await progress().waitFor();
  assert.equal(await progress().getAttribute('value'), '0');
  assert.equal(await progress().getAttribute('max'), '5');
  assert.equal(await panel().getByText('0%', { exact: true }).count(), 1);
  assert.equal(
    await progress().evaluate(
      (element) => getComputedStyle(element).accentColor,
    ),
    'rgb(139, 107, 69)',
  );
  results.push('未处理5张显示0%，原生进度条为棕色。');
  await panel()
    .getByRole('button', { name: '开始补分析', exact: true })
    .click();
  await eventually(async () => (await callCount(f.folder)) === 1);
  await writeFile(path.join(f.folder, 'mode.txt'), 'slow');
  await panel().getByText('60%', { exact: true }).waitFor();
  assert.equal(await progress().getAttribute('value'), '3');
  assert.equal(await progress().getAttribute('max'), '5');
  assert.equal(
    await progress().getAttribute('aria-valuetext'),
    '已分析 3 / 5 张，60%',
  );
  await page.screenshot({ path: path.join(preview, 'running-60.png') });
  results.push('首批真实保存3张后，进度与3/5同步为60%。');
  await eventually(async () => (await callCount(f.folder)) === 2);
  await page.reload();
  page = await application.firstWindow();
  await page.getByRole('button', { name: '整理', exact: true }).click();
  await panel().getByText('60%', { exact: true }).waitFor();
  assert.equal(await panel().getByLabel('补分析日期').inputValue(), day);
  assert.equal(await callCount(f.folder), 2);
  await panel()
    .getByRole('heading', { name: '补分析中', exact: true })
    .waitFor();
  results.push('刷新界面自动跟随正在运行的今天，60%恢复，后台调用数保持2次。');
  await panel()
    .getByRole('button', { name: '停止补分析', exact: true })
    .click();
  await panel().getByRole('heading', { name: '已停止', exact: true }).waitFor();
  assert.equal(await panel().getByText('60%', { exact: true }).count(), 1);
  results.push('停止保留已保存的60%进度。');
  await writeFile(path.join(f.folder, 'mode.txt'), 'success');
  await panel()
    .getByRole('button', { name: '继续补分析', exact: true })
    .click();
  await panel().getByText('100%', { exact: true }).waitFor();
  assert.equal(await progress().getAttribute('value'), '5');
  assert.equal(await callCount(f.folder), 3);
  await page.screenshot({ path: path.join(preview, 'completed-100.png') });
  results.push('继续仅补剩余2张，成功后为5/5与100%。');
  await panel().getByLabel('补分析日期').fill(moveDay(day, -3));
  await panel().getByRole('heading', { name: '这一天暂无截图' }).waitFor();
  assert.equal(await progress().count(), 0);
  await writeFile(path.join(f.home, 'records', `${day}.json`), '{broken');
  await panel().getByLabel('补分析日期').fill(day);
  await panel()
    .getByRole('heading', { name: '核对失败', exact: true })
    .waitFor();
  assert.equal(await progress().count(), 0);
  results.push('空日期与核对失败隐藏进度条。');
  assert.deepEqual(errors, []);
} finally {
  await application.close();
  await rm(f.folder, { recursive: true, force: true });
  await writeFile(
    path.join(report, packaged ? 'packaged.json' : 'electron.json'),
    JSON.stringify({ packaged, results, errors }, null, 2),
  );
}
console.log(JSON.stringify({ results, errors }, null, 2));
