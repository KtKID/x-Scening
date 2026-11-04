import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { localDay } from '../src/shared/protocol';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const report = path.join(root, 'reports/fix/task-organizer-lifecycle-20261101');
const temp = await mkdtemp(path.join(root, 'tmp/task-quit-'));
const home = path.join(temp, 'home');
const day = localDay();
await mkdir(path.join(home, 'records'), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temp, '.venv'));
await symlink(path.join(root, 'src'), path.join(temp, 'src'));
const recordFile = path.join(home, 'records', `${day}.json`);
const rows = JSON.stringify([
  {
    start: `${day}T09:00:00+08:00`,
    end: `${day}T09:01:00+08:00`,
    app: 'Editor',
    analysis: '【测试数据】排查登录问题',
    screenshot: 'fixture.jpg',
    mini: 'fixture.jpg',
  },
]);
await writeFile(recordFile, rows);
const model = path.join(temp, 'model.mjs');
const modelPid = path.join(temp, 'model.pid');
await writeFile(
  model,
  `import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(modelPid)},String(process.pid));setInterval(()=>{},1000);`,
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', home);
config.set('screenshotDir', path.join(temp, 'snapshots'));
config.set('kmhLauncher', model);
config.set('kmhProfile', 'fixture');
config.setIn(['taskTimeline', 'minOrganizeIntervalSeconds'], 0.001);
await writeFile(path.join(temp, 'observer.yaml'), config.toString());
const executable =
  process.env.TASK_PACKAGE_PATH ??
  path.join(
    desktop,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  );
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: process.env.TASK_PACKAGE_PATH ? [] : [desktop],
    env: {
      ...process.env,
      OBSERVER_PROJECT_ROOT: temp,
      OBSERVER_CONFIG: path.join(temp, 'observer.yaml'),
    },
  });
const waitForFile = async (file: string) => {
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};
let app = await launch();
const results: string[] = [];
try {
  await app.firstWindow();
  const pid = Number(await waitForFile(modelPid));
  const closed = app.waitForEvent('close', { timeout: 3000 });
  const started = Date.now();
  await app.evaluate(({ app }) => app.quit());
  await closed;
  const quitMs = Date.now() - started;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  execFileSync(path.join(root, '.venv/bin/python'), [
    '-c',
    'import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',
    path.join(home, 'task-timeline/.organize.lock'),
  ]);
  assert.equal(await readFile(recordFile, 'utf8'), rows);
  await assert.rejects(
    readFile(path.join(home, 'task-timeline', `${day}.json`)),
    {
      code: 'ENOENT',
    },
  );
  results.push('真实应用退出取消顽固模型，模型消失、整理锁释放、原活动保持。');
  await writeFile(
    model,
    "import fs from 'node:fs';const task=process.argv.at(-1);const file=task.match(/读取(.+?)，/)[1];const input=JSON.parse(fs.readFileSync(file,'utf8'));console.log(JSON.stringify({tasks:[],assignments:input.activities.map(a=>({activityId:a.id,taskKey:null})),progress:[]}));",
  );
  app = await launch();
  const page = await app.firstWindow();
  await waitForFile(path.join(home, 'task-timeline', `${day}.json`));
  assert.equal(await readFile(recordFile, 'utf8'), rows);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  const card = page.getByTestId('activity-card').first();
  await card.waitFor();
  assert.match(await card.innerText(), /排查登录问题/);
  assert.equal(await page.getByText(/TASK_ORGANIZER_/).count(), 0);
  results.push('重开同一home后下一轮正常提交，原活动保持，界面可继续查看。');
  await mkdir(report, { recursive: true });
  await writeFile(
    path.join(report, 'packaged-quit.json'),
    JSON.stringify(
      { packaged: Boolean(process.env.TASK_PACKAGE_PATH), quitMs, results },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
