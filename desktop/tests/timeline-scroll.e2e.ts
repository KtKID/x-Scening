import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { localDay } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/timeline-scroll');
const report = path.join(root, 'reports/fix/timeline-scroll-20261029');
await mkdir(evidence, { recursive: true });
await mkdir(report, { recursive: true });
const temporary = await mkdtemp(path.join(evidence, 'window-'));
const day = localDay();
const records = path.join(temporary, `home/records/${day}.json`);
await mkdir(path.dirname(records), { recursive: true });
await writeFile(
  path.join(temporary, 'home/screen.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8f28rAzbAhFV00EoAAPfdApLUYjL3AAAAAElFTkSuQmCC',
    'base64',
  ),
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', './home');
config.set('screenshotDir', './pictures');
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
const observation = {
  schema_version: 1,
  visible_activity: '【测试数据】核对卡片类型。',
  inferred_intent: '【测试数据】推测在检查展示。',
  stage_and_evidence: '【测试数据】展示验证中。',
  app_tags: ['Fixture App'],
};
const base = {
  app: 'Fixture App',
  screenshot: 'screen.png',
  mini: 'screen.png',
  source: 'screen',
};
const longType = '用于验证历史自定义类型在窄窗口中完整换行的名称'.repeat(3);
const rows = [
  {
    ...base,
    start: `${day}T09:00:00+08:00`,
    end: `${day}T09:01:00+08:00`,
    analysis: '【测试数据】多项类型活动。核对工作与学习标签。',
    observation: { ...observation, task_types: ['工作', '学习'] },
  },
  {
    ...base,
    start: `${day}T09:02:00+08:00`,
    end: `${day}T09:03:00+08:00`,
    analysis: '【测试数据】空列表活动。核对待分类状态。',
    observation: { ...observation, task_types: [] },
  },
  {
    ...base,
    start: `${day}T09:04:00+08:00`,
    end: `${day}T09:05:00+08:00`,
    analysis: '【测试数据】旧结果缺少类型。核对兼容展示。',
    observation,
  },
  {
    ...base,
    start: `${day}T09:06:00+08:00`,
    end: `${day}T09:07:00+08:00`,
    analysis: '【测试数据】旧活动没有观察对象。核对兼容展示。',
  },
  {
    ...base,
    start: `${day}T09:08:00+08:00`,
    end: `${day}T09:09:00+08:00`,
    analysis: '【测试数据】历史自定义类型。核对长名称与预设外历史值。',
    observation: {
      ...observation,
      task_types: ['已从预设移除的类型', longType],
    },
  },
];
const scrollRows = Array.from({ length: 30 }, (_, index) => ({
  ...rows[0],
  start: `${day}T09:${String(index).padStart(2, '0')}:00+08:00`,
  end: `${day}T09:${String(index).padStart(2, '0')}:30+08:00`,
}));
const original = JSON.stringify(scrollRows);
await writeFile(records, original);
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
const packagedExecutable = process.env.OBSERVER_TEST_EXECUTABLE;
const application = await electron.launch({
  executablePath: packagedExecutable ?? executable,
  args: packagedExecutable ? [] : [desktop],
  env: { ...process.env, OBSERVER_PROJECT_ROOT: temporary },
  timeout: 30000,
});
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByTestId('activity-card').first().waitFor();
  assert.match(await page.locator('.connection').innerText(), /v0\.1\.1/);
  const body = page.locator('.workspace-body');
  await body.evaluate((element) => {
    element.scrollTop = 700;
  });
  await page.waitForFunction(
    () => document.querySelector('.workspace-body')?.scrollTop === 700,
  );
  for (const tab of ['总结', '设置', '总结']) {
    await page
      .locator('.sidebar')
      .getByRole('button', { name: tab, exact: true })
      .click();
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    assert.equal(await body.evaluate((element) => element.scrollTop), 700);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(
      report,
      packagedExecutable ? 'packaged-result.json' : 'result.json',
    ),
    JSON.stringify(
      {
        build: packagedExecutable ? 'packaged' : 'development',
        scrollTop: 700,
        switches: 3,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: timeline scroll position retained across summary/settings tab switches',
  );
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
