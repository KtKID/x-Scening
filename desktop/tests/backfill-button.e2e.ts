import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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
const report = path.join(root, 'reports/today-analysis-queue-20261031');
const screenshots = path.join(root, 'tmp/backfill-button-preview');
await mkdir(report, { recursive: true });
await mkdir(screenshots, { recursive: true });
const source = (await readdir(f.shots))[0];
assert.ok(source);
await copyFile(
  path.join(f.shots, source),
  path.join(f.shots, `${localDay()}_09-00-00_m1_action.jpg`),
);
await copyFile(
  path.join(f.shots, source),
  path.join(f.shots, `${moveDay(localDay(), 1)}_09-00-00_m1_action.jpg`),
);
const packaged = process.env.BACKFILL_PACKAGED === '1';
const checks: string[] = [];
const styles: {
  state: string;
  color: string;
  background: string;
  cursor: string;
}[] = [];
const pageErrors: string[] = [];
const CSS_TRANSITION_SETTLE_MS = 200;
function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)?.map(Number);
  assert.ok(channels && channels.length >= 3);
  return channels
    .slice(0, 3)
    .map((value) => {
      const s = value / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce(
      (total, value, index) =>
        total + value * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
}
function contrast(color: string, background: string): number {
  const first = luminance(color);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
const application = await electron.launch({
  executablePath: path.join(
    desktop,
    packaged
      ? 'release/mac-arm64/x-scening.app/Contents/MacOS/Observer'
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
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const analysisSwitch = page.getByRole('switch', { name: '开启分析' });
  if ((await analysisSwitch.getAttribute('aria-checked')) === 'true') {
    await analysisSwitch.click();
    await page
      .getByRole('switch', { name: '开启分析', checked: false })
      .waitFor();
  }
  await page.getByRole('button', { name: '整理', exact: true }).click();
  const panel = page.getByRole('region', { name: '补分析页面' });
  const button = panel.locator('.backfill-action-row').getByRole('button');
  await panel.getByText(f.shots, { exact: true }).waitFor();
  const directoryOpened = application.evaluate(
    ({ shell }) =>
      new Promise<string>((resolve) => {
        shell.openPath = (target) => {
          resolve(target);
          return Promise.resolve('');
        };
      }),
  );
  await panel.getByRole('button', { name: '打开保存目录' }).click();
  assert.equal(await directoryOpened, f.shots);
  checks.push('整理页显示解析后的截图目录，并将同一目录交给系统文件管理器。');
  const date = panel.getByLabel('补分析日期');
  const readStyle = async (state: string) => {
    const value = await button.evaluate((element) => {
      const css = getComputedStyle(element);
      return {
        color: css.color,
        background: css.backgroundColor,
        cursor: css.cursor,
      };
    });
    styles.push({ state, ...value });
    return value;
  };
  await panel.getByRole('heading', { name: '待补分析', exact: true }).waitFor();
  await page.mouse.move(2, 2);
  const normal = await readStyle('ready');
  assert.ok(contrast(normal.color, normal.background) >= 4.5);
  await button.hover();
  await page.waitForTimeout(CSS_TRANSITION_SETTLE_MS);
  const hovered = await readStyle('ready-hover');
  assert.ok(
    contrast(hovered.color, hovered.background) >= 4.5,
    '悬停文字与底色对比度至少4.5',
  );
  assert.equal(hovered.cursor, 'pointer');
  assert.notEqual(hovered.background, normal.background);
  await page.mouse.down();
  const pressed = await readStyle('ready-active');
  assert.ok(contrast(pressed.color, pressed.background) >= 4.5);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await button.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(
    await button.evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await button.evaluate((element) => getComputedStyle(element).outlineStyle),
    'solid',
  );
  await page.screenshot({ path: path.join(screenshots, 'ready-hover.png') });
  checks.push('可开始按钮正常与悬停对比度合格，悬停为手型，键盘焦点可见。');
  await writeFile(path.join(f.folder, 'mode.txt'), 'slow');
  await button.click();
  await panel.getByRole('heading', { name: '补分析中', exact: true }).waitFor();
  await eventually(async () => (await callCount(f.folder)) === 1);
  await panel.getByRole('button', { name: '停止补分析', exact: true }).click();
  await panel.getByRole('heading', { name: '已停止', exact: true }).waitFor();
  checks.push('真实点击开始启动Python和受控模型；点击停止后保留5张待分析。');
  await date.fill(localDay());
  await panel
    .getByRole('button', { name: '开始补分析', exact: true })
    .waitFor();
  assert.equal(await button.isEnabled(), true);
  await writeFile(path.join(f.folder, 'mode.txt'), 'success');
  await button.click();
  await panel
    .getByRole('heading', { name: '全部已分析', exact: true })
    .waitFor();
  assert.equal(await callCount(f.folder), 2);
  await page.screenshot({
    path: path.join(screenshots, 'today-completed.png'),
  });
  checks.push('实时分析关闭时今天仍可手动开始，真实Python单张尾批提交完成。');
  await date.fill(moveDay(localDay(), 1));
  await panel
    .getByRole('button', { name: '请选择今天或更早日期', exact: true })
    .waitFor();
  assert.equal(await button.isDisabled(), true);
  assert.equal(
    await panel
      .getByText('点击开始，应用会自动补齐待分析截图。', { exact: true })
      .count(),
    0,
  );
  await page.mouse.move(2, 2);
  const disabled = await readStyle('future-disabled');
  await button.hover({ force: true });
  await page.waitForTimeout(CSS_TRANSITION_SETTLE_MS);
  const disabledHover = await readStyle('future-disabled-hover');
  assert.equal(disabledHover.cursor, 'default');
  assert.equal(disabledHover.background, disabled.background);
  assert.equal(disabledHover.color, disabled.color);
  assert.ok(contrast(disabledHover.color, disabledHover.background) >= 4.5);
  await page.screenshot({
    path: path.join(screenshots, 'future-disabled.png'),
  });
  checks.push('未来日期明确禁用，按钮悬停稳定、普通光标，页面无点击开始提示。');
  await date.fill(moveDay(f.day, -2));
  await panel.getByRole('button', { name: '暂无截图', exact: true }).waitFor();
  assert.equal(await button.isDisabled(), true);
  checks.push('空日期按钮显示暂无截图，禁用原因直接可见。');
  await date.fill(f.day);
  await panel
    .getByRole('button', { name: '继续补分析', exact: true })
    .waitFor();
  await writeFile(path.join(f.folder, 'mode.txt'), 'success');
  await button.click();
  await panel
    .getByRole('heading', { name: '全部已分析', exact: true })
    .waitFor();
  assert.equal(await callCount(f.folder), 4);
  await button.hover({ force: true });
  assert.equal((await readStyle('completed-hover')).cursor, 'default');
  checks.push('恢复后真实3+2保存完成，全部已分析按钮使用普通光标。');
  assert.deepEqual(pageErrors, []);
} finally {
  await application.close();
  await rm(f.folder, { recursive: true, force: true });
  await writeFile(
    path.join(report, packaged ? 'packaged-button.json' : 'button.json'),
    JSON.stringify({ packaged, checks, styles, pageErrors }, null, 2),
  );
}
console.log(JSON.stringify({ checks, styles, pageErrors }, null, 2));
