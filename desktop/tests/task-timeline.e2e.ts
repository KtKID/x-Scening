import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDay } from '../src/shared/protocol';
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/task-linked-timeline-mvp');
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(path.join(evidence, 'smoke-'));
const home = path.join(temp, 'home');
const day = localDay();
for (const dir of ['records', 'task-timeline', 'activity-evidence'])
  await mkdir(path.join(home, dir), { recursive: true });
const rows = [
  ['09:00', '09:01', 'Chrome', '排查登录问题'],
  ['10:00', '10:01', 'Notes', '记录设置方案'],
  ['14:00', '14:01', 'Editor', '验证登录结果'],
].map(([start, end, app, analysis]) => ({
  start: `${day}T${start}:00+08:00`,
  end: `${day}T${end}:00+08:00`,
  app,
  analysis,
  screenshot: 'a.jpg',
  mini: 'a.jpg',
  source: 'screen',
}));
await writeFile(
  path.join(home, 'records', `${day}.json`),
  JSON.stringify(rows),
);
const defaults = await readFile(path.join(root, 'observer.yaml'), 'utf8');
await writeFile(
  path.join(temp, 'observer.yaml'),
  defaults
    .replace(/^home:.*$/m, 'home: ./home')
    .replace(/^screenshotDir:.*$/m, 'screenshotDir: ./snapshots'),
);
// 预先保存模型建议结果，真实读取、投影、桥接和交互均走正式入口。
const { execFileSync } = await import('node:child_process');
const prepare = `import json,sys,hashlib
from pathlib import Path
home=Path(sys.argv[1]);day=sys.argv[2];rows=json.loads((home/'records'/f'{day}.json').read_text())
def sig(r):
 p={k:r.get(k) for k in ['start','app','bundleId','source','analysis','observation','screenshot','mini','frames']}
 return hashlib.sha256(json.dumps(p,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
assignments=[]
for i,r in enumerate(rows):
 assignments.append(dict(activityId=hashlib.sha256(f'{day}:{i}:{r["start"]}'.encode()).hexdigest()[:24],sourceSignature=sig(r),taskId='login' if i!=1 else 'settings'))
content=dict(schemaVersion=1,day=day,generatedAt=rows[-1]['end'],coveredUntil=rows[-1]['end'],semanticRevision='',tasks=[dict(taskId='login',day=day,title='修复登录',object='登录',goal='修复异常'),dict(taskId='settings',day=day,title='设置方案',object='设置',goal='形成方案')],assignments=assignments,progress=[])
content['progress']=[dict(progressId='progress-login',taskId='login',text='已记录登录排查过程',kind='observed',completionScope='历史任务整体完成结论',evidence=[dict(activityId=assignments[0]['activityId'],sourceSignature=assignments[0]['sourceSignature'],excerpt=rows[0]['analysis'])])]
(home/'task-timeline'/f'{day}.json').write_text(json.dumps(content,ensure_ascii=False))
samples=[]
for i,r in enumerate(rows):
 for j,key in enumerate(['start','end']):
  samples.append(dict(sampleId=f's{i}-{j}',activityId=assignments[i]['activityId'],sourceSignature=assignments[i]['sourceSignature'],capturedAt=r[key],runId='smoke',continuityId='same',sampleSequence=i*2+j,app=r['app'],bundleId=None,screen=1))
(home/'activity-evidence'/f'{day}.json').write_text(json.dumps(dict(schemaVersion=1,day=day,samples=samples,breaks=[])))
`;
execFileSync(path.join(root, '.venv/bin/python'), ['-c', prepare, home, day]);
const executable = path.join(
  desktop,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);
const app = await electron.launch({
  executablePath: executable,
  args: [desktop],
  env: { ...process.env, OBSERVER_PROJECT_ROOT: temp },
  timeout: 30000,
});
const results: string[] = [];
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  const cards = page.getByTestId('activity-card');
  await cards
    .filter({ hasText: '修复登录' })
    .first()
    .waitFor({ timeout: 15000 });
  await cards.first().click();
  await page
    .getByRole('heading', { name: '任务详情', exact: true })
    .waitFor({ timeout: 5000 });
  assert.equal(
    await page
      .locator('.task-details')
      .getByRole('heading', { name: '修复登录', exact: true })
      .count(),
    1,
  );
  results.push('T16：原活动关联到登录任务详情');
  await page.getByText('已记录登录排查过程', { exact: true }).waitFor();
  assert.doesNotMatch(
    await page.locator('.task-details').innerText(),
    /完成范围|完成状态|历史任务整体完成结论/,
  );
  results.push('T4：旧任务记录保留活动与依据，完成范围和状态文案停用');
  await page.getByRole('button', { name: '回看 09:00 的记录' }).click();
  results.push('T11/T12/T17：进展展示证据并可点击回看');
  await page.getByLabel('全天时间分布').waitFor();
  results.push('T21：详情显示全天时间条');
  await page.getByRole('button', { name: 'Chrome', exact: true }).click();
  await page.getByTestId('activity-card').first().click();
  await page
    .locator('.investment-link')
    .filter({ hasText: '14:00' })
    .first()
    .click();
  await page.getByText('已显示当天全部活动', { exact: true }).waitFor();
  assert.equal(await cards.count(), 3);
  assert.equal(
    await page.locator('[data-segment-id][aria-pressed="true"]').count(),
    1,
  );
  results.push('T17/T19：跨应用片段恢复筛选并定位');
  const selected = page.locator('[data-segment-id][aria-pressed="true"]');
  assert.ok((await selected.innerText()).includes('14:00'));
  const colors = await cards.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).borderLeftColor),
  );
  assert.equal(colors[0], colors[2]);
  results.push('T07/T21：同任务两段颜色一致');
  const track = page.getByRole('button', {
    name: '全天时间条，点击时间段回看任务',
    exact: true,
  });
  await track.scrollIntoViewIfNeeded();
  const trackBox = await track.boundingBox();
  assert.ok(trackBox);
  await page.mouse.click(
    trackBox.x + trackBox.width * (60.5 / 301),
    trackBox.y + trackBox.height / 2,
  );
  await page
    .locator('.task-details')
    .getByRole('heading', { name: '设置方案', exact: true })
    .waitFor();
  await track.scrollIntoViewIfNeeded();
  const gapBox = await track.boundingBox();
  assert.ok(gapBox);
  await page.mouse.click(
    gapBox.x + gapBox.width * (30 / 301),
    gapBox.y + gapBox.height / 2,
  );
  await page
    .getByRole('status')
    .filter({ hasText: '观察归属或连续时间待确认' })
    .waitFor();
  results.push('T18：时间条可切换其他任务，待确认区间显示说明');
  await cards.last().click();
  await page.screenshot({ path: path.join(evidence, 'task-details.png') });
  await page.setViewportSize({ width: 850, height: 720 });
  assert.equal(
    await page.locator('.inspector.has-selection').isVisible(),
    true,
  );
  await page.screenshot({ path: path.join(evidence, 'task-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 940 });
  results.push('T09：850px详情抽屉可用');
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('heading', { name: '当日概览', exact: true }).waitFor();
  results.push('T17：关闭详情保留页面');
  const dense = Array.from({ length: 197 }, (_, index) => ({
    ...rows[0],
    start: `${day}T11:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+08:00`,
    end: `${day}T11:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+08:00`,
    analysis: `长记录 ${String(index)}：整理资料。`,
  }));
  await writeFile(
    path.join(home, 'records', `${day}.json`),
    JSON.stringify([...rows, ...dense]),
  );
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="activity-card"]').length === 200,
  );
  const middleCard = cards.nth(100);
  await middleCard.scrollIntoViewIfNeeded();
  await middleCard.click();
  await page.getByRole('heading', { name: '活动详情', exact: true }).waitFor();
  const anchor = await middleCard.getAttribute('data-segment-id');
  const before = await middleCard.boundingBox();
  await writeFile(
    path.join(home, 'records', `${day}.json`),
    JSON.stringify([
      ...rows,
      ...dense,
      {
        ...rows[0],
        start: `${day}T15:00:00+08:00`,
        end: `${day}T15:01:00+08:00`,
      },
    ]),
  );
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="activity-card"]').length === 201,
  );
  assert.ok(anchor);
  const retained = page.locator(`[data-segment-id="${anchor}"]`);
  const after = await retained.boundingBox();
  assert.ok(before && after && Math.abs(before.y - after.y) < 3);
  results.push(
    'T09/T10：200条记录可浏览，追加后选择和阅读位置保持，待关联记录可打开原详情',
  );
  await writeFile(
    path.join(home, 'records', `${day}.json`),
    JSON.stringify(rows),
  );
  await page.getByRole('button', { name: '前一天', exact: true }).click();
  await page
    .getByRole('heading', { name: '这一天暂无活动', exact: true })
    .waitFor();
  results.push('T24：空日清除详情');
  assert.deepEqual(errors, []);
  assert.equal(
    JSON.stringify(
      JSON.parse(
        await readFile(path.join(home, 'records', `${day}.json`), 'utf8'),
      ),
    ),
    JSON.stringify(rows),
  );
  results.push('原观察文件保持，页面异常0');
} catch (error) {
  const page = await app.firstWindow();
  await writeFile(path.join(evidence, 'failure.html'), await page.content());
  await page.screenshot({ path: path.join(evidence, 'failure.png') });
  throw error;
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
await writeFile(
  path.join(root, 'reports/task-linked-timeline-mvp/smoke.json'),
  JSON.stringify({ results, errors }, null, 2),
);
console.log(results);
