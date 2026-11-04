import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { localDay } from '../src/shared/protocol';
import { DayTasksSchema } from '../src/shared/scening.generated';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const report =
  process.env.MULTI_REPORT ?? path.join(root, 'reports/multi-task-20261101');
const evidence =
  process.env.MULTI_EVIDENCE ?? path.join(root, 'tmp/multi-task-20261101');
await mkdir(report, { recursive: true });
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(path.join(root, 'tmp/me-'));
const home = path.join(temp, 'home');
const day = localDay();
await mkdir(path.join(home, 'records'), { recursive: true });
await mkdir(path.join(home, 'task-timeline'), { recursive: true });
await mkdir(path.join(home, 'summaries'), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temp, '.venv'));
await symlink(path.join(root, 'src'), path.join(temp, 'src'));
const row = {
  start: `${day}T09:00:00+08:00`,
  end: `${day}T09:03:00+08:00`,
  app: '无线麦',
  analysis:
    '第1帧：调整麦克风映射。\n第2帧：测试语音输入。\n第3帧：修改博客段落。',
  screenshot: 'batch.jpg',
  mini: 'batch.jpg',
  frames: ['无线麦', 'ZCode', 'Editor'].map((app, i) => ({
    capturedAt: `${day}T09:0${String(i)}:00+08:00`,
    app,
    screenshot: `frame${String(i + 1)}.jpg`,
    screen: 1,
  })),
  observation: {
    schema_version: 1,
    visible_activity: '【测试数据】配置麦克风与修改博客',
    inferred_intent: '验证多任务记录',
    stage_and_evidence: '已有原文依据',
    app_tags: [],
    task_types: ['工作', '学习'],
  },
};
const records = path.join(home, 'records', `${day}.json`);
await writeFile(records, JSON.stringify([row]));
const original = await readFile(records);
execFileSync(
  path.join(root, '.venv/bin/python'),
  [
    '-c',
    `
from pathlib import Path
from PIL import Image
import sys,json
from scening.task_store import read_activities
home=Path(sys.argv[1]);day=sys.argv[2];rows,_=read_activities(home,day);r=rows[0]
for i,color in enumerate(('red','green','blue'),1):Image.new('RGB',(120,80),color).save(home/f'frame{i}.jpg')
Image.new('RGB',(120,240),'ivory').save(home/'batch.jpg')
doc=dict(schemaVersion=1,day=day,generatedAt=r['end'],coveredUntil=r['end'],semanticRevision='',tasks=[dict(taskId='old-mic',day=day,title='配置麦克风按键',object='麦克风',goal='配置按键')],assignments=[dict(activityId=r['id'],sourceSignature=r['signature'],taskId='old-mic')],progress=[])
(home/'task-timeline'/f'{day}.json').write_text(json.dumps(doc,ensure_ascii=False))
`,
    home,
    day,
  ],
  { env: { ...process.env, PYTHONPATH: path.join(root, 'src') } },
);
const taskFile = path.join(home, 'task-timeline', `${day}.json`);
const oldTask = await readFile(taskFile);
const rawImages = await Promise.all(
  [1, 2, 3].map((i) => readFile(path.join(home, `frame${String(i)}.jpg`))),
);
const summary =
  '【测试数据】今天，你先在无线麦和ZCode中检查按键映射与语音输入，随后在编辑器调整博客段落。这份记录同时保留了两项事情，各自的进展和原文可以分别回看。'.repeat(
    8,
  );
const model = path.join(temp, 'model.mjs');
await writeFile(
  model,
  `import fs from 'node:fs';const task=process.argv.at(-1);if(task.includes('taskLinks')){const input=JSON.parse(fs.readFileSync(task.match(/读取(.+?)，/)[1],'utf8'));const r=input.activities[0];const e=input.evidenceOptions;console.log(JSON.stringify({schemaVersion:2,tasks:[{key:'blog',title:'修改博客内容',object:'博客',goal:'修改文章'}],assignments:[{activityId:r.id,taskLinks:[{taskKey:'old-mic',action:'【测试数据】调整按键映射并测试语音',evidenceIds:[e[0].id,e[1].id],progress:[{text:'麦克风映射已调整',kind:'observed',evidenceIds:[e[0].id]}]},{taskKey:'blog',action:'【测试数据】修改文章段落',evidenceIds:[e[2].id],progress:[{text:'博客段落已修改',kind:'observed',evidenceIds:[e[2].id]}]}],unassignedEvidenceIds:[]}]}));}else process.stdout.write(${JSON.stringify(summary)});`,
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
await writeFile(
  path.join(home, 'summaries', `${day}.json`),
  JSON.stringify([
    {
      windowStart: row.start,
      windowEnd: row.end,
      generatedAt: row.end,
      summary: '【测试数据】两项活动',
      timeline: [],
      gaps: [],
      trigger: 'periodic',
    },
  ]),
);
const app = await electron.launch({
  executablePath:
    process.env.MULTI_PACKAGE_PATH ??
    path.join(
      desktop,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ),
  args: process.env.MULTI_PACKAGE_PATH ? [] : [desktop],
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
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  const cards = page.getByTestId('activity-card');
  await page
    .getByRole('button', { name: /修改博客内容/ })
    .first()
    .waitFor();
  assert.equal(await cards.count(), 1);
  assert.equal(
    await cards.first().getByRole('list', { name: '任务类型' }).count(),
    1,
  );
  await page.screenshot({ path: path.join(evidence, 'multi-task-wide.png') });
  assert.equal(await cards.first().locator('.task-link-tag').count(), 2);
  assert.equal(await cards.first().locator('.task-branches').count(), 0);
  results.push(
    '三帧原记录展示一张普通卡、两个可点击任务标签和一组分类，正文保持。',
  );
  await cards
    .first()
    .getByRole('button', { name: /配置麦克风按键/ })
    .click();
  const details = page.locator('.task-details');
  await details
    .getByRole('heading', { name: '配置麦克风按键', exact: true })
    .waitFor();
  assert.match(await details.innerText(), /麦克风映射已调整/);
  assert.doesNotMatch(await details.innerText(), /博客段落已修改/);
  await details.getByRole('button', { name: '查看图1', exact: true }).click();
  const first = page.getByRole('img', { name: '原始截图 图1', exact: true });
  await first.waitFor();
  assert.equal(
    await first.getAttribute('src'),
    `data:image/jpeg;base64,${rawImages[0]?.toString('base64')}`,
  );
  await page.getByRole('button', { name: '图3', exact: true }).click();
  const third = page.getByRole('img', { name: '原始截图 图3', exact: true });
  await third.waitFor();
  assert.equal(
    await third.getAttribute('src'),
    `data:image/jpeg;base64,${rawImages[2]?.toString('base64')}`,
  );
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await cards
    .first()
    .getByRole('button', { name: /修改博客内容/ })
    .click();
  await details
    .getByRole('heading', { name: '修改博客内容', exact: true })
    .waitFor();
  assert.match(await details.innerText(), /博客段落已修改/);
  assert.doesNotMatch(await details.innerText(), /麦克风映射已调整/);
  await details
    .getByRole('button', {
      name: '全天时间条，点击时间段回看任务',
      exact: true,
    })
    .click({ position: { x: 20, y: 5 } });
  await details
    .getByRole('heading', { name: '修改博客内容', exact: true })
    .waitFor();
  assert.equal(
    await cards.first().locator('.selected-task-tag').innerText(),
    '修改博客内容',
  );
  results.push(
    '任务详情隔离进展和原文；图1、图3读取各自原始JPEG字节；混合时间条回看当前任务标签。',
  );
  await page.setViewportSize({ width: 850, height: 900 });
  await page.screenshot({ path: path.join(evidence, 'multi-task-narrow.png') });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '总结', exact: true }).last().click();
  const modal = page.getByRole('dialog', { name: '当日档案', exact: true });
  await modal.waitFor();
  assert.equal(await modal.locator('.review-prose').innerText(), summary);
  assert.match(
    await modal.locator('.archive-metrics').innerText(),
    /1\s*条活动记录/,
  );
  assert.match(
    await modal.locator('.archive-metrics').innerText(),
    /3\s*个应用/,
  );
  assert.match(
    await modal.locator('.archive-metrics').innerText(),
    /2\s*项关联任务/,
  );
  const target = path.join(temp, 'archive.png');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath: file });
  }, target);
  await modal.getByRole('button', { name: '保存图片', exact: true }).click();
  await modal.getByText(/图片已保存/).waitFor();
  await copyFile(target, path.join(evidence, 'multi-task-archive.png'));
  results.push(
    '宽窄窗口可用；完整档案保留正文，统计为1记录/3应用/2任务，实际导出PNG。',
  );
  const raw: unknown = JSON.parse(await readFile(taskFile, 'utf8'));
  const saved = DayTasksSchema.parse(raw);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.assignments.length, 1);
  assert.equal(saved.assignments[0]?.taskLinks.length, 2);
  const backups = await readdir(path.join(home, 'task-timeline/backups'));
  assert.equal(backups.length, 1);
  const backup = backups[0];
  assert.ok(backup);
  assert.deepEqual(
    await readFile(path.join(home, 'task-timeline/backups', backup)),
    oldTask,
  );
  assert.deepEqual(await readFile(records), original);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      await readFile(path.join(home, `frame${String(i + 1)}.jpg`)),
      rawImages[i],
    );
  assert.deepEqual(errors, []);
  results.push('v1原字节备份后升级v2，原记录和三张原图保持，页面异常0。');
  await writeFile(
    path.join(report, 'multi-task-window.json'),
    JSON.stringify(
      {
        packaged: Boolean(process.env.MULTI_PACKAGE_PATH),
        results,
        errors,
        summaryChars: summary.length,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
