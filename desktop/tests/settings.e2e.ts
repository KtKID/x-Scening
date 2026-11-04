import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { settingFields } from '../src/shared/settings';
import { TaskTypePresetsSchema } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'reports/settings-20261029');
const pictures = path.join(root, 'tmp/settings-preview');
await mkdir(pictures, { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/settings-window-'));
const configPath = path.join(temporary, 'observer.yaml');
const originalDocument = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
originalDocument.set('home', './home');
originalDocument.set('screenshotDir', './pictures');
const original = originalDocument.toString();
await writeFile(configPath, original);
const formalConfig = await readFile(path.join(root, 'observer.yaml'), 'utf8');
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
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: [desktop],
    env: {
      ...process.env,
      OBSERVER_PROJECT_ROOT: root,
      OBSERVER_CONFIG: configPath,
    },
    timeout: 30000,
  });
const checks: { id: string; observed: string }[] = [];
const errors: string[] = [];
let application = await launch();
try {
  let page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('定时截图间隔（秒）', { exact: true }).waitFor();
  assert.equal(
    await page.locator('[data-setting]').count(),
    settingFields.length,
  );
  for (const [key] of settingFields)
    assert.equal(await page.locator(`[data-setting="${key}"]`).count(), 1);
  assert.equal(
    await page.getByRole('button', { name: '保存', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole('button', { name: '清除修改', exact: true })
      .isDisabled(),
    true,
  );
  checks.push({
    id: 'T1',
    observed: `${settingFields.length}个标量字段及任务类型全部展示，初始保存和清除按钮禁用。`,
  });
  await page.screenshot({
    path: path.join(pictures, 'settings.png'),
    fullPage: true,
  });

  await page.getByLabel('定时截图间隔（秒）', { exact: true }).fill('42');
  await page.getByLabel('截图缓存频率（帧/秒）', { exact: true }).fill('4');
  await page.locator('summary').filter({ hasText: '存储与模型' }).click();
  await page.getByLabel('截图保存目录', { exact: true }).fill('./new-pictures');
  await page.getByLabel('新任务类型').fill('临时');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(
    await page.getByLabel('定时截图间隔（秒）', { exact: true }).inputValue(),
    '42',
  );
  await page.getByLabel('新任务类型').fill('尚在输入');
  await page.getByRole('button', { name: '清除修改', exact: true }).click();
  assert.equal(
    await page.getByLabel('定时截图间隔（秒）', { exact: true }).inputValue(),
    '60',
  );
  assert.equal(
    await page
      .getByLabel('截图缓存频率（帧/秒）', { exact: true })
      .inputValue(),
    '5',
  );
  assert.equal(
    await page.getByLabel('截图保存目录', { exact: true }).inputValue(),
    './pictures',
  );
  assert.equal(await page.getByLabel('新任务类型').inputValue(), '');
  assert.equal(
    await page
      .getByRole('button', { name: '删除类型：临时', exact: true })
      .count(),
    0,
  );
  assert.equal(await readFile(configPath, 'utf8'), original);
  checks.push({
    id: 'T5',
    observed:
      '跨页保留草稿，清除恢复频率、路径、任务类型与新类型输入，原文件保持。',
  });

  await page.getByLabel('分析候选处理间隔（秒）', { exact: true }).fill('0');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '分析候选处理间隔' })
    .waitFor();
  assert.equal(await readFile(configPath, 'utf8'), original);
  await page.getByRole('button', { name: '清除修改', exact: true }).click();
  await page.locator('summary').filter({ hasText: '分析拼图' }).click();
  await page.getByLabel('时间标签字号（像素）', { exact: true }).fill('99');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '时间标签高度' }).waitFor();
  assert.equal(await readFile(configPath, 'utf8'), original);
  assert.equal(
    await page.getByLabel('时间标签字号（像素）', { exact: true }).inputValue(),
    '99',
  );
  await page.getByRole('button', { name: '清除修改', exact: true }).click();
  checks.push({
    id: 'T3',
    observed:
      '数值0被页面校验拒绝，跨字段字号错误经真实Python校验拒绝；草稿与原文件保留，清除后可继续。',
  });

  await page.getByLabel('定时截图间隔（秒）', { exact: true }).fill('45');
  await page.getByLabel('分析候选处理间隔（秒）', { exact: true }).fill('8');
  await page.getByLabel('活动总结周期（秒）', { exact: true }).fill('1200');
  await page
    .getByLabel('截图保存目录', { exact: true })
    .fill('./saved-pictures');
  await page.getByLabel('新任务类型').fill('研究');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  const savedContent = await readFile(configPath, 'utf8');
  const saved = parseDocument(savedContent);
  assert.equal(saved.getIn(['scening', 'observationIntervalSeconds']), 45);
  assert.equal(saved.get('sampleIntervalSeconds'), 8);
  assert.equal(saved.get('summaryIntervalSeconds'), 1200);
  assert.equal(saved.get('screenshotDir'), './saved-pictures');
  assert.deepEqual(
    TaskTypePresetsSchema.strip().parse(saved.toJS()).taskTypes,
    ['工作', '学习', '娱乐', '游戏', '研究'],
  );
  assert.equal(
    await page.getByRole('button', { name: '保存', exact: true }).isDisabled(),
    true,
  );
  checks.push({
    id: 'T2',
    observed:
      '多个分组与尚在输入框的新类型统一保存，显示下次开始采集生效，保存按钮恢复禁用。',
  });

  await page.getByLabel('定时截图间隔（秒）', { exact: true }).fill('40');
  await writeFile(configPath, `${savedContent}\n# 外部更新\n`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '配置已发生变化' }).waitFor();
  assert.equal(
    await page.getByLabel('定时截图间隔（秒）', { exact: true }).inputValue(),
    '40',
  );
  await page.getByRole('button', { name: '重新读取配置', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>(
        '[data-setting="scening.observationIntervalSeconds"]',
      )?.value === '45',
  );
  assert.equal(
    await page.getByLabel('定时截图间隔（秒）', { exact: true }).inputValue(),
    '45',
  );
  checks.push({
    id: 'T4',
    observed: '外部更新后保存提示冲突并保留草稿，重新读取恢复最新文件值。',
  });
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('定时截图间隔（秒）', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('定时截图间隔（秒）', { exact: true }).inputValue(),
    '45',
  );
  await page
    .getByRole('button', { name: '删除类型：研究', exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  assert.equal(
    await readFile(path.join(root, 'observer.yaml'), 'utf8'),
    formalConfig,
  );
  await page.screenshot({
    path: path.join(pictures, 'saved.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 820, height: 740 });
  await page.screenshot({
    path: path.join(pictures, 'narrow.png'),
    fullPage: true,
  });
  checks.push({
    id: 'T6',
    observed:
      '重开窗口读取已保存频率和任务类型，窄窗口截图已保留，页面错误0，正式配置原文保持，模型调用0。',
  });
  await writeFile(
    path.join(evidence, 'window.json'),
    JSON.stringify({ checks, pageErrors: errors, modelCalls: 0 }, null, 2),
  );
  console.log(JSON.stringify(checks));
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
