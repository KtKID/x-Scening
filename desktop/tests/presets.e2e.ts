import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { TaskTypePresetsSchema } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const output = path.join(root, 'tmp/task-type-presets');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(output, 'window-'));
const configPath = path.join(temporary, 'observer.yaml');
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', './home');
config.set('screenshotDir', './pictures');
await writeFile(configPath, config.toString());
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
const errors: string[] = [];
const environment = {
  ...process.env,
  OBSERVER_PROJECT_ROOT: root,
  OBSERVER_CONFIG: configPath,
};
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: [desktop],
    env: environment,
    timeout: 30000,
  });
let application = await launch();
try {
  let page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '预设', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('list', { name: '任务类型预设' })
      .locator('li')
      .count(),
    4,
  );
  await page.getByLabel('新任务类型').fill('研究');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page
    .getByRole('button', { name: '删除类型：娱乐', exact: true })
    .click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  const saved = parseDocument(await readFile(configPath, 'utf8'));
  const raw: unknown = saved.toJS();
  assert.deepEqual(TaskTypePresetsSchema.strip().parse(raw).taskTypes, [
    '工作',
    '学习',
    '游戏',
    '研究',
  ]);
  assert.equal(saved.get('home'), './home');
  await page.getByLabel('新任务类型').fill('工作');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '这个类型已在预设中' })
    .waitFor();
  await page.getByLabel('新任务类型').fill('');
  await page.screenshot({
    path: path.join(output, 'settings.png'),
    fullPage: true,
  });
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page
    .getByRole('button', { name: '删除类型：研究', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: '删除类型：娱乐', exact: true })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: path.join(output, 'reopened.png'),
    fullPage: true,
  });
  await writeFile(
    path.join(root, 'reports/task-type-presets-20261029/window.json'),
    JSON.stringify(
      {
        defaults: ['工作', '学习', '娱乐', '游戏'],
        saved: ['工作', '学习', '游戏', '研究'],
        added: '研究',
        removed: '娱乐',
        duplicateRejected: true,
        reopenedPersisted: true,
        pageErrors: errors,
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    '预设增删、保存、重复提示与重开读取均通过；页面错误0，模型调用0。',
  );
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
