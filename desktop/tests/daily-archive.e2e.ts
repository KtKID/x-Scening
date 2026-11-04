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
const evidence = path.join(root, 'tmp/daily-archive-20261101');
const report = path.join(root, 'reports/daily-archive-20261101');
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(path.join(evidence, 'window-'));
const home = path.join(temp, 'home');
const day = localDay();
for (const dir of ['records', 'summaries', 'task-timeline'])
  await mkdir(path.join(home, dir), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temp, '.venv'));
await symlink(path.join(root, 'src'), path.join(temp, 'src'));
const response = [
  '【测试数据】今天的记录主要围绕个人 Agent 的工作方式展开。你在多个工具之间来回查看，把注意力放在交互流程、上下文衔接和日常使用体验上。零散的操作逐渐形成了几条清晰的线索：整理已有动作、理解新的方案，以及回看已经留下的活动记录。',
  '凌晨，你先在组合动作页面查看并编排 Codex 的相关步骤，随后配置蓝牙遥控器的按键映射。画面中出现了打开应用、触发按键和长按参数等设置，这些记录保留了你为语音输入与工具调用寻找顺手入口的过程。',
  '之后，你转到 ChatGPT 阅读 AI Agent 方案，对比多种工具的组合方式。期间还查看了市场分析与产品差异的讨论，关注点从具体配置延伸到工具各自承担的角色，以及它们怎样进入真实的使用场景。',
  '后半段，你继续阅读 Agent Loop 分解、项目文档和博客草稿，并回到 observer 查看活动记录。阅读、配置与回顾交替出现，今天的探索同时包含理解思路和检查实际使用过程，两者都留下了可以继续追踪的片段。',
  '这份回顾整理了当天已经保存的可见活动。部分时段的记录较为稀疏，连续操作和任务结果仍有待后续确认。你可以从今天反复出现的语音入口、工具衔接和活动回顾这几条线索继续往下走，让已有的尝试逐步积累成更稳定的日常工作方式。',
].join('\n\n');
const replyFile = path.join(temp, 'reply.txt');
await writeFile(replyFile, response);
const model = path.join(temp, 'model.mjs');
await writeFile(
  model,
  "import {readFileSync} from 'node:fs';import path from 'node:path';setTimeout(()=>{const text=readFileSync(path.join(import.meta.dirname,'reply.txt'),'utf8');if(text==='FAIL')process.exit(2);process.stdout.write(text);},100);",
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', home);
config.set('screenshotDir', path.join(temp, 'snapshot'));
config.set('kmhLauncher', model);
config.set('kmhProfile', 'fixture');
await writeFile(path.join(temp, 'observer.yaml'), config.toString());
const rows = [
  ['Editor', ['工作', '学习']],
  ['Browser', ['工作']],
  ['Editor', []],
].map(([app, types], i) => ({
  app,
  start: `${day}T0${i + 8}:00:00+08:00`,
  end: `${day}T0${i + 8}:01:00+08:00`,
  analysis: `【测试数据】活动${i + 1}，核对档案与任务卡。`,
  screenshot: 'fixture.jpg',
  mini: 'fixture.jpg',
  observation: {
    schema_version: 1,
    visible_activity: '查看记录',
    inferred_intent: '验证界面',
    stage_and_evidence: '测试',
    app_tags: [app],
    task_types: types,
  },
}));
// 第三条时间为10点，使用日期对象格式化避免无效的010小时。
rows.forEach((row, i) => {
  row.start = `${day}T${String(8 + i).padStart(2, '0')}:00:00+08:00`;
  row.end = `${day}T${String(8 + i).padStart(2, '0')}:01:00+08:00`;
});
const records = path.join(home, 'records', `${day}.json`);
await writeFile(records, JSON.stringify(rows));
const period = {
  windowStart: `${day}T08:00:00+08:00`,
  windowEnd: `${day}T08:30:00+08:00`,
  generatedAt: `${day}T08:31:00+08:00`,
  summary: '【测试数据】回顾合成活动。',
  timeline: [],
  gaps: [],
  trigger: 'periodic',
};
await writeFile(
  path.join(home, 'summaries', `${day}.json`),
  JSON.stringify([period]),
);
execFileSync(
  path.join(root, '.venv/bin/python'),
  [
    '-c',
    `
from pathlib import Path
import sys,json
from scening.task_store import read_activities
home=Path(sys.argv[1]);day=sys.argv[2];rows,_=read_activities(home,day)
assignments=[dict(activityId=r['id'],sourceSignature=r['signature'],taskId='first' if i<2 else 'second') for i,r in enumerate(rows)]
doc=dict(schemaVersion=1,day=day,generatedAt=rows[-1]['end'],coveredUntil=rows[-1]['end'],semanticRevision='',tasks=[dict(taskId='first',day=day,title='整理工具流程',object='工具',goal='整理流程'),dict(taskId='second',day=day,title='阅读界面文档',object='文档',goal='阅读')],assignments=assignments,progress=[])
(home/'task-timeline'/f'{day}.json').write_text(json.dumps(doc,ensure_ascii=False))
`,
    home,
    day,
  ],
  { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'src') } },
);
const originalRecords = await readFile(records, 'utf8');
const executable =
  process.env.ARCHIVE_PACKAGE_PATH ??
  path.join(
    desktop,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  );
const packaged = Boolean(process.env.ARCHIVE_PACKAGE_PATH);
const app = await electron.launch({
  executablePath: executable,
  args: packaged ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: temp,
    OBSERVER_CONFIG: path.join(temp, 'observer.yaml'),
  },
  timeout: 30000,
});
const errors: string[] = [];
const results: string[] = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  const cards = page.locator('.task-segment');
  await cards.first().waitFor();
  assert.deepEqual(
    await cards
      .first()
      .getByRole('list', { name: '任务类型' })
      .getByRole('listitem')
      .allTextContents(),
    ['工作', '学习'],
  );
  assert.doesNotMatch(await cards.first().innerText(), /第\s*\d+\s*次投入/);
  assert.match(await cards.first().innerText(), /关联任务：整理工具流程/);
  const tagBounds = await cards
    .first()
    .getByRole('list', { name: '任务类型' })
    .boundingBox();
  const cardBounds = await cards.first().boundingBox();
  const headingBounds = await cards.first().getByRole('heading').boundingBox();
  assert.ok(tagBounds && cardBounds && headingBounds);
  assert.ok(tagBounds.x > cardBounds.x + cardBounds.width / 2);
  assert.ok(tagBounds.y < headingBounds.y);
  await page.screenshot({ path: path.join(evidence, 'tags-top-right.png') });
  await cards.first().click();
  assert.deepEqual(
    await page
      .locator('.task-details')
      .getByRole('list', { name: '任务类型' })
      .getByRole('listitem')
      .allTextContents(),
    ['工作', '学习'],
  );
  await page.screenshot({ path: path.join(evidence, 'task-types.png') });
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  results.push('T5：任务卡与详情保留多类型、同名关联；次数文案退役。');
  await page
    .locator('.overview')
    .getByRole('button', { name: '总结', exact: true })
    .click();
  const modal = page.getByRole('dialog', { name: '当日档案', exact: true });
  await modal.waitFor();
  assert.equal(await modal.locator('.review-prose').textContent(), response);
  const metrics = await modal.getByLabel('当日档案统计').innerText();
  assert.match(metrics, /3 条活动记录/);
  assert.match(metrics, /2 个应用/);
  assert.match(metrics, /2 项关联任务/);
  assert.match(
    await modal.getByLabel('活动类型统计').innerText(),
    /工作 2次 · 50%/,
  );
  await page.screenshot({ path: path.join(evidence, 'archive-wide.png') });
  results.push(
    `T1/T4：完整${response.length}字五段正文，3条活动、2应用、2任务；类型2/1/1，多选口径明确。`,
  );
  const target = path.join(evidence, 'daily-archive.png');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath });
  }, target);
  await modal.getByRole('button', { name: '保存图片', exact: true }).click();
  await modal
    .getByRole('status')
    .filter({ hasText: '图片已保存' })
    .waitFor({ timeout: 30000 });
  const image = await readFile(target);
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.equal(image.readUInt32BE(16), 1080);
  assert.ok(image.readUInt32BE(20) > 1100);
  await writeFile(
    path.join(report, 'png.json'),
    JSON.stringify(
      {
        width: image.readUInt32BE(16),
        height: image.readUInt32BE(20),
        bytes: image.length,
        bodyChars: response.length,
      },
      null,
      2,
    ),
  );
  results.push('T3：真实主进程渲染1080px宽全文PNG并保存，图像高度随正文增长。');
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = () =>
      Promise.resolve({ canceled: true, filePath: '' });
  });
  await modal.getByRole('button', { name: '保存图片', exact: true }).click();
  await modal.getByRole('status').filter({ hasText: '已取消保存' }).waitFor();
  assert.deepEqual(await readFile(target), image);
  results.push('T3取消：保存框取消保持已保存图片字节。');
  const occupied = path.join(temp, 'occupied.png');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'original.txt'), '原文件');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath });
  }, occupied);
  await modal.getByRole('button', { name: '保存图片', exact: true }).click();
  await modal
    .getByRole('status')
    .filter({ hasText: '保存失败' })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await readFile(path.join(occupied, 'original.txt'), 'utf8'),
    '原文件',
  );
  results.push('T3失败：目标位置异常有提示且已有内容保持。');
  await page.setViewportSize({ width: 850, height: 720 });
  await page.screenshot({ path: path.join(evidence, 'archive-narrow.png') });
  const scroll = modal.locator('.archive-scroll');
  assert.ok(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight));
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  assert.equal(await modal.locator('.review-prose').textContent(), response);
  await page.keyboard.press('Escape');
  assert.equal(await modal.count(), 0);
  results.push('T4窄窗：正文可滚动，关闭/保存按钮可用，Escape关闭。');
  await page.setViewportSize({ width: 1440, height: 940 });
  const longer = response.repeat(8);
  await writeFile(replyFile, longer);
  await page
    .locator('.overview')
    .getByRole('button', { name: '总结', exact: true })
    .click();
  await modal.waitFor();
  await page.waitForFunction(
    (text) => document.querySelector('.review-prose')?.textContent === text,
    longer,
  );
  assert.equal(await modal.locator('.review-prose').textContent(), longer);
  await app.evaluate(
    ({ dialog }, filePath) => {
      dialog.showSaveDialog = () =>
        Promise.resolve({ canceled: false, filePath });
    },
    path.join(evidence, 'daily-archive-long.png'),
  );
  await modal.getByRole('button', { name: '保存图片', exact: true }).click();
  await modal
    .getByRole('status')
    .filter({ hasText: '图片已保存' })
    .waitFor({ timeout: 30000 });
  const longImage = await readFile(
    path.join(evidence, 'daily-archive-long.png'),
  );
  assert.ok(longImage.readUInt32BE(20) > image.readUInt32BE(20) * 4);
  results.push(
    `T3/T4长文：${longer.length}字全文保留，PNG高度${longImage.readUInt32BE(20)}px，失败后重试成功。`,
  );
  await writeFile(replyFile, response);
  await modal.getByRole('button', { name: '重新生成', exact: true }).click();
  await page.waitForFunction(
    (text) => document.querySelector('.review-prose')?.textContent === text,
    response,
  );
  const savedReview = path.join(home, 'daily-reviews', `${day}.json`);
  const previousReview = await readFile(savedReview, 'utf8');
  await writeFile(replyFile, 'FAIL');
  await modal.getByRole('button', { name: '重新生成', exact: true }).click();
  await modal.getByRole('alert').waitFor();
  assert.equal(await modal.locator('.review-prose').textContent(), response);
  assert.equal(await readFile(savedReview, 'utf8'), previousReview);
  await writeFile(replyFile, response);
  await modal.getByRole('button', { name: '重新生成', exact: true }).click();
  await modal.getByRole('button', { name: '重新生成', exact: true }).waitFor();
  assert.equal(await modal.getByRole('alert').count(), 0);
  results.push('重新生成失败在弹窗内提示，原正文和回顾文件保持，重试恢复。');
  assert.equal(await readFile(records, 'utf8'), originalRecords);
  assert.deepEqual(errors, []);
  results.push('重新生成成功、原始活动只读、页面异常0；回顾完整保存。');
  await writeFile(
    path.join(report, packaged ? 'packaged-window.json' : 'window.json'),
    JSON.stringify({ results, errors, packaged }, null, 2),
  );
  console.log(JSON.stringify({ results, errors, packaged }));
  if (process.env.KEEP_ARCHIVE_WINDOW === '1') {
    console.log('ARCHIVE_WINDOW_READY');
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once('data', resolve));
    process.stdin.pause();
  }
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
