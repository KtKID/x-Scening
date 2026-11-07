import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { BaseWindow, OpenDialogOptions } from 'electron';
import { _electron as electron } from 'playwright';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { localDay } from '../src/shared/protocol';

const desktop = path.resolve(import.meta.dirname, '..');
const project = path.dirname(desktop);
const temporary = await mkdtemp(path.join(project, 'tmp/snap-'));
const targetParent =
  process.env.SCENING_E2E_SNAPSHOT_TMP ?? path.join(temporary, '.scening/TMP');
const targetName = path.basename(temporary);
const target = path.join(targetParent, targetName);
const day = localDay();
const oldRoot = path.join(temporary, 'data/snapshot-v1');
const configPath = path.join(temporary, 'observer_dev.yaml');
const logPath = path.join(temporary, 'logs/x-scening.log');
const appPath = process.env.SCENING_E2E_APP ?? desktop;
const executable = path.join(
  desktop,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);
const IndexSchema = z.object({
  images: z.array(z.object({ file: z.string() })),
});
const EventSchema = z.object({
  stage: z.string(),
  result: z.string(),
  screenshot: z.string().optional(),
});
const MetadataSchema = z.object({ capturedAt: z.string(), file: z.string() });

async function files(root: string) {
  try {
    return IndexSchema.parse(
      JSON.parse(await readFile(path.join(root, day, 'index.json'), 'utf8')),
    ).images.map(({ file }) => path.join(root, file));
  } catch (error: unknown) {
    if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success)
      return [];
    throw error;
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await setTimeout(100);
  }
  throw new Error(`等待超时：${label}`);
}

let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
let ownsTarget = false;
try {
  const original = parseDocument(
    await readFile(path.join(project, 'observer.yaml'), 'utf8'),
  );
  original.setIn(['scening', 'observationIntervalSeconds'], 2);
  original.setIn(['privacy', 'enabled'], false);
  await writeFile(path.join(temporary, 'observer.yaml'), original.toString());
  await writeFile(
    path.join(temporary, 'observer.defaults_dev.yaml'),
    await readFile(path.join(project, 'observer.defaults_dev.yaml')),
  );
  await symlink(path.join(project, '.venv'), path.join(temporary, '.venv'));
  const fixture = path.join(temporary, 'src/scening');
  await mkdir(fixture, { recursive: true });
  const scening = path.join(project, 'src/scening');
  await writeFile(
    path.join(fixture, '__init__.py'),
    `__path__.append(${JSON.stringify(scening)})\n`,
  );
  // 仅替换原生屏幕与权限，实际入口、JPEG、索引及日志继续走产品代码。
  await writeFile(
    path.join(fixture, 'observe_activity.py'),
    `import runpy
from PIL import Image
from scening import collector, permissions
from scening.capture import Display

class FixtureScreen:
    def __init__(self, timeout): pass
    def displays(self): return [Display(1, 0, 0, 160, 90)]
    def pointer(self): return (10, 10)
    def idle_seconds(self): return 0
    def display_asleep(self): return False
    def grab(self, display): return Image.new('RGB', (display.width, display.height), 'teal')
    def start_inputs(self, submit, clock): return True
    def close(self): pass

collector.NativeBackend = FixtureScreen
permissions.screen_capture_allowed = lambda: True
runpy.run_path(${JSON.stringify(path.join(scening, 'observe_activity.py'))}, run_name='__main__')
`,
  );
  await mkdir(targetParent, { recursive: true });
  await mkdir(target);
  ownsTarget = true;
  const env = { ...process.env, OBSERVER_PROJECT_ROOT: temporary };
  Reflect.deleteProperty(env, 'OBSERVER_CONFIG');
  application = await electron.launch({
    executablePath: executable,
    args: [appPath],
    env,
  });
  const page = await application.firstWindow();
  const coveragePath = process.env.SCENING_E2E_COVERAGE;
  if (coveragePath) await page.coverage.startJSCoverage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('switch', { name: '开启分析' }).click();
  await page.getByRole('button', { name: '开始截屏', exact: true }).click();
  await page.getByRole('status').getByText('采集中', { exact: true }).waitFor();
  const oldImage = await waitFor(
    async () => (await files(oldRoot))[0],
    oldRoot,
  );
  const oldBytes = await readFile(oldImage);
  const oldMetadata = await readFile(`${oldImage}.metadata.json`);
  const logBefore = await readFile(logPath, 'utf8');
  const before = await page.evaluate(() => window.observer?.readRuntime());
  assert.ok(before && 'pid' in before.capture);

  const records = path.join(temporary, 'home/records');
  await mkdir(records, { recursive: true });
  const at = MetadataSchema.parse(
    JSON.parse(oldMetadata.toString()),
  ).capturedAt;
  await writeFile(
    path.join(records, `${day}.json`),
    JSON.stringify([
      {
        start: at,
        end: at,
        app: 'Fixture',
        analysis: '路径切换前的活动',
        screenshot: oldImage,
        mini: oldImage,
        source: 'screen',
        frames: [{ capturedAt: at, screenshot: oldImage, app: 'Fixture' }],
      },
    ]),
  );

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const field = page.getByLabel('截图保存目录', { exact: true });
  await field.waitFor();
  assert.equal(await field.inputValue(), './data/snapshot-v1');
  const picker = page.getByRole('button', { name: '选择文件夹', exact: true });
  await picker.waitFor({ timeout: 4000 });
  const save = page.getByRole('button', { name: '保存', exact: true });
  const originalConfig = await readFile(configPath, 'utf8');
  await field.fill('./draft-pictures');
  await application.evaluate(
    ({ dialog }, { oldRoot, target }) => {
      let count = 0;
      dialog.showOpenDialog = async (
        _owner: BaseWindow | OpenDialogOptions,
        options?: OpenDialogOptions,
      ) => {
        if (
          options?.defaultPath !== oldRoot ||
          !options.properties?.includes('openDirectory') ||
          !options.properties.includes('createDirectory')
        )
          throw new Error('目录窗口应从当前截图目录打开并允许选择或创建目录');
        count += 1;
        if (count === 1) {
          await new Promise<void>((resolve) =>
            globalThis.setTimeout(resolve, 750),
          );
          return { canceled: true, filePaths: [] };
        }
        return { canceled: false, filePaths: [target] };
      };
    },
    { oldRoot, target },
  );
  await picker.click();
  await picker.and(page.locator(':disabled')).waitFor();
  assert.ok(await save.isDisabled());
  await picker.and(page.locator(':enabled')).waitFor();
  assert.equal(await field.inputValue(), './draft-pictures');
  assert.ok(await save.isEnabled());
  assert.equal(await readFile(configPath, 'utf8'), originalConfig);
  await picker.click();
  await page.waitForFunction((target) => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-setting="screenshotDir"]',
    );
    return input?.value === target;
  }, target);
  assert.equal(await readFile(configPath, 'utf8'), originalConfig);
  assert.deepEqual(await readdir(target), []);
  await save.click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  const saved = parseDocument(await readFile(configPath, 'utf8'));
  assert.equal(saved.get('screenshotDir'), target);
  assert.equal(saved.get('home'), './home');

  const oldIndex = await readFile(path.join(oldRoot, day, 'index.json'));
  const newImage = await waitFor(async () => (await files(target))[0], target);
  await page.waitForFunction(async (oldPid) => {
    const state = await window.observer?.readRuntime();
    return state && 'pid' in state.capture && state.capture.pid === oldPid;
  }, before.capture.pid);
  const logAfter = await waitFor(async () => {
    const log = await readFile(logPath, 'utf8');
    return log.includes(JSON.stringify(newImage)) ? log : undefined;
  }, '新截图的日志');
  assert.ok(logAfter.startsWith(logBefore));
  const logEvents = logAfter
    .split('\n')
    .filter(Boolean)
    .map((line) => EventSchema.parse(JSON.parse(line)));
  assert.ok(
    logEvents.some(
      (event) =>
        event.stage === 'scening' &&
        event.result === 'candidate' &&
        event.screenshot === newImage,
    ),
  );
  assert.ok(
    (await readFile(newImage))
      .subarray(0, 3)
      .equals(Buffer.from([255, 216, 255])),
  );
  assert.equal(
    MetadataSchema.parse(
      JSON.parse(await readFile(`${newImage}.metadata.json`, 'utf8')),
    ).file,
    path.relative(target, newImage),
  );
  assert.deepEqual(await readdir(target), [day]);
  assert.deepEqual(await readFile(oldImage), oldBytes);
  assert.deepEqual(await readFile(`${oldImage}.metadata.json`), oldMetadata);
  assert.deepEqual(
    await readFile(path.join(oldRoot, day, 'index.json')),
    oldIndex,
  );

  const history = await page.evaluate(async (day) => {
    const snapshot = await window.observer?.readDay({ day, source: 'local' });
    const activity = snapshot?.activities.find(
      (item) => item.analysis === '路径切换前的活动',
    );
    return activity && window.observer?.readImage(activity.id, 1);
  }, day);
  assert.equal(history?.status, 'ready');
  if (history?.status === 'ready')
    assert.deepEqual(
      Buffer.from(history.dataUrl.split(',')[1] ?? '', 'base64'),
      oldBytes,
    );
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: '停止截屏', exact: true }).click();
  await page.getByRole('status').getByText('已停止', { exact: true }).waitFor();
  if (coveragePath)
    await writeFile(
      coveragePath,
      JSON.stringify(await page.coverage.stopJSCoverage()),
    );
  console.log(
    JSON.stringify({
      mode: 'dev',
      pid: before.capture.pid,
      oldImage,
      newImage,
      logPath,
      history: history.status,
      errors,
    }),
  );
} finally {
  await application?.close();
  if (ownsTarget) await rm(target, { recursive: true });
  await rm(temporary, { recursive: true });
}
