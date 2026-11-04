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
const report =
  process.env.GROUP_REPORT ??
  path.join(root, 'reports/task-card-grouping-20261101');
const evidence =
  process.env.GROUP_EVIDENCE ??
  path.join(root, 'tmp/task-card-grouping-20261101');
await mkdir(report, { recursive: true });
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(path.join(root, 'tmp/gg-'));
const home = path.join(temp, 'home');
const day = localDay();
await mkdir(path.join(home, 'records'), { recursive: true });
await mkdir(path.join(home, 'task-timeline'), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temp, '.venv'));
await symlink(path.join(root, 'src'), path.join(temp, 'src'));
const data = [
  ['11:51:56', '13:50:46', '观看视频并查看工程会话列表', 'Chrome', 'mixed'],
  ['11:58:43', '11:59:15', '观看国际时政评论视频', 'Chrome', 'watch'],
  ['11:59:43', '12:03:43', '观看波士顿圆脸口播视频', 'Chrome', 'watch'],
  ['12:03:44', '12:08:43', '继续播放解读类评论视频', 'Chrome', 'watch'],
  ['14:00:00', '14:01:00', '下午观看第一段', 'Chrome', 'watch'],
  ['14:01:20', '14:01:30', '记录资料说明', 'Notes', 'dev'],
  ['14:02:00', '14:03:00', '下午观看第二段', 'Chrome', 'watch'],
];
const rows = data.map(([start, end, action, app, task]) => ({
  start: `${day}T${start ?? ''}+08:00`,
  end: `${day}T${end ?? ''}+08:00`,
  app,
  analysis: `【测试数据】${action ?? ''}`,
  screenshot: 'a.jpg',
  mini: 'a.jpg',
  observation: {
    schema_version: 1,
    visible_activity: `【测试数据】${action ?? ''}`,
    inferred_intent: '验证卡片展示',
    stage_and_evidence: '保留活动原文',
    app_tags: [],
    task_types:
      task === 'mixed'
        ? ['工作', '娱乐']
        : task === 'watch'
          ? ['娱乐']
          : ['工作'],
  },
}));
const records = path.join(home, 'records', `${day}.json`);
await writeFile(records, JSON.stringify(rows));
const original = await readFile(records);
execFileSync(
  path.join(root, '.venv/bin/python'),
  [
    '-c',
    `
import json,sys
from pathlib import Path
from PIL import Image
from scening.task_store import read_activities
home=Path(sys.argv[1]);day=sys.argv[2];rows,_=read_activities(home,day)
Image.new('RGB',(120,80),'ivory').save(home/'a.jpg')
tasks=[dict(taskId=t,day=day,title=title,object=t,goal=t) for t,title in [('watch','观看B站解读视频'),('dev','收集开发资料')]]
assignments=[]
for i,r in enumerate(rows):
 ids=['watch','dev'] if i==0 else ['dev'] if i==5 else ['watch']
 proof=dict(activityId=r['id'],sourceSignature=r['signature'],excerpt=r['analysis'],frameIndexes=[])
 assignments.append(dict(activityId=r['id'],sourceSignature=r['signature'],relationVersion=2,taskLinks=[dict(taskId=t,action=r['analysis'],evidence=[proof]) for t in ids],unassignedEvidence=[]))
doc=dict(schemaVersion=2,day=day,generatedAt=rows[-1]['end'],coveredUntil=rows[-1]['end'],semanticRevision='',tasks=tasks,assignments=assignments,progress=[])
(home/'task-timeline'/f'{day}.json').write_text(json.dumps(doc,ensure_ascii=False))
`,
    home,
    day,
  ],
  { env: { ...process.env, PYTHONPATH: path.join(root, 'src') } },
);
const taskFile = path.join(home, 'task-timeline', `${day}.json`);
const taskBefore = await readFile(taskFile);
const calls = path.join(temp, 'calls');
const model = path.join(temp, 'model.cjs');
await writeFile(
  model,
  `require('fs').writeFileSync(${JSON.stringify(calls)},'unexpected model');process.exit(1)`,
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', home);
config.set('screenshotDir', path.join(temp, 'snapshots'));
config.set('kmhLauncher', model);
config.set('kmhProfile', 'fixture');
await writeFile(path.join(temp, 'observer.yaml'), config.toString());
const app = await electron.launch({
  executablePath:
    process.env.GROUP_PACKAGE_PATH ??
    path.join(
      desktop,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ),
  args: process.env.GROUP_PACKAGE_PATH ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: temp,
    OBSERVER_CONFIG: path.join(temp, 'observer.yaml'),
  },
});
const results: string[] = [];
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  const group = page.getByTestId('task-group');
  await group.waitFor();
  assert.equal(await group.count(), 1);
  assert.equal(await group.getByTestId('activity-card').count(), 3);
  const first = group.getByTestId('activity-card').nth(0),
    second = group.getByTestId('activity-card').nth(1),
    third = group.getByTestId('activity-card').nth(2);
  assert.match(await group.innerText(), /11:58.*12:08/);
  for (const card of [first, second, third])
    assert.match(await card.innerText(), /时长待确认/);
  results.push(
    '截图三个时间段形成1任务组、3活动子卡，原时间和时长待确认保留。',
  );
  const multi = page
    .getByTestId('activity-card')
    .filter({ hasText: '观看视频并查看工程会话列表' });
  assert.equal(await multi.count(), 1);
  assert.equal(await multi.locator('.task-link-tag').count(), 2);
  assert.equal(await multi.locator('.task-branches').count(), 0);
  assert.equal(
    await multi
      .getByRole('list', { name: '任务类型' })
      .getByRole('listitem')
      .count(),
    2,
  );
  await multi
    .getByRole('button', { name: '收集开发资料', exact: true })
    .click();
  await page
    .locator('.task-details h3')
    .filter({ hasText: '收集开发资料' })
    .waitFor();
  results.push('多任务原记录保持普通卡，两个任务标签各自可点，右上分类完整。');
  await second.click();
  const details = page.locator('.task-details');
  await details
    .getByRole('heading', { name: '观看B站解读视频', exact: true })
    .waitFor();
  await details
    .locator('.investment-link')
    .filter({ hasText: /12:03\s*—\s*12:08/ })
    .click();
  assert.equal(await third.getAttribute('aria-pressed'), 'true');
  const before = await page
    .locator('.workspace-body')
    .evaluate((el) => el.scrollTop);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await third.waitFor();
  assert.equal(await third.getAttribute('aria-pressed'), 'true');
  assert.ok(
    Math.abs(
      (await page.locator('.workspace-body').evaluate((el) => el.scrollTop)) -
        before,
    ) < 8,
  );
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'single-task-group.png') });
  results.push(
    '子卡点击、详情各次投入和刷新定位保留原片段，任务时间条继续可用。',
  );
  await page.getByRole('button', { name: 'Chrome', exact: true }).click();
  assert.equal(await page.getByTestId('task-group').count(), 1);
  assert.equal(
    await page
      .getByTestId('activity-card')
      .filter({ hasText: '下午观看' })
      .count(),
    2,
  );
  await page.setViewportSize({ width: 850, height: 900 });
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(evidence, 'single-task-group-narrow.png'),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(await readFile(records), original);
  assert.deepEqual(await readFile(taskFile), taskBefore);
  assert.deepEqual(errors, []);
  let unexpected = false;
  try {
    await readFile(calls);
    unexpected = true;
  } catch {
    /* 预期未创建模型调用记录。 */
  }
  assert.equal(unexpected, false);
  results.push(
    '筛选隐藏中间任务后两侧记录仍分开，窄窗可用；关系/原记录保持，模型调用0，页面异常0。',
  );
  await writeFile(
    path.join(report, 'window.json'),
    JSON.stringify(
      { packaged: Boolean(process.env.GROUP_PACKAGE_PATH), results, errors },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
