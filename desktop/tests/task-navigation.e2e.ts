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
const temp = await mkdtemp(path.join(evidence, 'navigation-'));
const home = path.join(temp, 'home');
const day = localDay();
for (const dir of ['records', 'task-timeline', 'activity-evidence'])
  await mkdir(path.join(home, dir), { recursive: true });
const rows = [
  ['09:00', '09:01', 'Chrome', '排查登录问题'],
  ['10:00', '10:01', 'Notes', '记录设置方案'],
  ['14:00', '14:01', 'Editor', '验证登录结果'],
  ['18:00', '18:00', 'Notes', '目标待关联的单次观察'],
].map(([start, end, app, analysis]) => ({
  start: `${day}T${start}:00+08:00`,
  end: `${day}T${end}:00+08:00`,
  app,
  analysis,
  screenshot: 'a.jpg',
  mini: 'a.jpg',
  source: 'screen',
}));
rows.push(
  ...Array.from({ length: 50 }, (_, i) => ({
    start: `${day}T11:${String(i).padStart(2, '0')}:00+08:00`,
    end: `${day}T11:${String(i).padStart(2, '0')}:10+08:00`,
    app: 'Notes',
    analysis: `资料浏览 ${String(i)}`,
    screenshot: 'a.jpg',
    mini: 'a.jpg',
    source: 'screen',
  })),
);
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
 assignments.append(dict(activityId=hashlib.sha256(f'{day}:{i}:{r["start"]}'.encode()).hexdigest()[:24],sourceSignature=sig(r),taskId=('settings' if i==1 else 'login') if i<3 else None))
content=dict(schemaVersion=1,day=day,generatedAt=rows[-1]['end'],coveredUntil=rows[-1]['end'],semanticRevision='',tasks=[dict(taskId='login',day=day,title='修复登录',object='登录',goal='修复异常'),dict(taskId='settings',day=day,title='设置方案',object='设置',goal='形成方案')],assignments=assignments,progress=[])
content['progress']=[dict(progressId='progress-login',taskId='login',text='已记录登录排查过程',kind='observed',completionScope=None,evidence=[dict(activityId=assignments[0]['activityId'],sourceSignature=assignments[0]['sourceSignature'],excerpt=rows[0]['analysis'])])]
(home/'task-timeline'/f'{day}.json').write_text(json.dumps(content,ensure_ascii=False))
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
const failures: string[] = [];
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  const cards = page.getByTestId('activity-card');
  const first = cards.filter({ hasText: '排查登录问题' }).first();
  const last = cards.filter({ hasText: '验证登录结果' }).first();
  await first.waitFor({ timeout: 15000 });
  const title = page.locator('.task-details h3');
  async function check(name: string, run: () => Promise<void>) {
    try {
      await run();
      results.push(name);
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function located(target: typeof first) {
    const inViewport = () => {
      const el = document.querySelector(
        '[data-segment-id][aria-pressed="true"]',
      );
      const root = document.querySelector('.workspace-body');
      if (!el || !root) return false;
      const b = el.getBoundingClientRect(),
        r = root.getBoundingClientRect();
      return b.top >= r.top && b.top < r.bottom - 30;
    };
    await page.waitForFunction(inViewport, undefined, { timeout: 2500 });
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    await page.waitForFunction(inViewport, undefined, { timeout: 2500 });
    assert.equal(await target.getAttribute('aria-pressed'), 'true');
  }
  await check('回看离屏记录后定位保持', async () => {
    await first.click();
    await cards.last().scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '回看 09:00 的记录' }).click();
    await located(first);
    await cards.last().scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '回看 09:00 的记录' }).click();
    await located(first);
    // 跨过项目配置的2秒自动刷新，核对主动定位后的锚点。
    await page.waitForTimeout(2300);
    await located(first);
    assert.equal(await title.innerText(), '修复登录');
  });
  await check('各次投入跨筛选定位并保留详情', async () => {
    await page.getByRole('button', { name: 'Chrome', exact: true }).click();
    await first.click();
    await page.locator('.investment-link').filter({ hasText: '14:00' }).click();
    await page.getByText('已显示当天全部活动', { exact: true }).waitFor();
    await located(last);
    assert.equal(await title.innerText(), '修复登录');
  });
  const track = page.getByRole('button', {
    name: '全天时间条，点击时间段回看任务',
    exact: true,
  });
  async function clickTime(hour: number, minute: number) {
    await track.waitFor({ timeout: 2500 });
    await track.scrollIntoViewIfNeeded();
    const box = await track.boundingBox();
    assert.ok(box);
    const dimensions = await track.evaluate((el) => ({
      width: el.clientWidth,
      border: el.clientLeft,
    }));
    await page.mouse.click(
      box.x +
        dimensions.border +
        dimensions.width * ((hour * 60 + minute - 540) / 540),
      box.y + box.height / 2,
    );
  }
  await check('历史观察块保留任务颜色与待确认耗时', async () => {
    await first.click();
    assert.equal(await page.locator('.timebar-observation.task').count(), 3);
    assert.equal(
      await page.locator('.task-details > p').nth(1).innerText(),
      '时长待确认 · 关联 2 条记录',
    );
    const block = page.locator('.timebar-observation.task').nth(1);
    const color = await block.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    assert.equal(
      color,
      await cards
        .filter({ hasText: '记录设置方案' })
        .evaluate((el) => getComputedStyle(el).borderLeftColor),
    );
  });
  await check('鼠标点极短任务块跳转其他任务', async () => {
    await clickTime(10, 0.5);
    assert.equal(await title.innerText(), '设置方案');
    await located(cards.filter({ hasText: '记录设置方案' }));
  });
  await check('鼠标点当前任务另一段正确定位', async () => {
    await clickTime(14, 0.5);
    assert.equal(await title.innerText(), '修复登录');
    await located(last);
  });
  await check('鼠标点未关联观察点立即定位并保留任务详情', async () => {
    await clickTime(18, -0.01);
    assert.equal(await title.innerText(), '修复登录');
    const selected = page.locator('[data-segment-id][aria-pressed="true"]');
    await located(selected);
    assert.ok((await selected.innerText()).includes('目标待关联的单次观察'));
    assert.equal(await page.locator('.timebar-options').count(), 0);
  });
  await check('灰色空白原处说明并保持详情和阅读位置', async () => {
    await first.click();
    const before = await page
      .locator('.workspace-body')
      .evaluate((el) => el.scrollTop);
    await clickTime(16, 0);
    await page
      .getByRole('status')
      .filter({ hasText: '未记录' })
      .waitFor({ timeout: 2500 });
    assert.equal(await title.innerText(), '修复登录');
    assert.equal(
      await page.locator('.workspace-body').evaluate((el) => el.scrollTop),
      before,
    );
  });
  await check('密集观察第一下点击即定位对应卡片', async () => {
    await clickTime(11, 20.05);
    assert.equal(await title.innerText(), '修复登录');
    const target = page.locator('[data-segment-id][aria-pressed="true"]');
    await located(target);
    // 全天压缩后一分钟小于一个像素，按点击位置相邻的一像素记录范围验收。
    assert.match(await target.innerText(), /资料浏览 (19|20|21)\b/);
    assert.equal(await page.locator('.timebar-options').count(), 0);
  });
  await check('窄窗口时间条可点击且保留任务详情', async () => {
    await page.setViewportSize({ width: 850, height: 720 });
    await clickTime(10, 0.5);
    assert.equal(await title.innerText(), '设置方案');
    await page.setViewportSize({ width: 1440, height: 940 });
  });
  await check('键盘可选择明确任务时间段', async () => {
    await track.focus();
    await track.press('Enter');
    await page
      .locator('.timebar-selection')
      .getByRole('button', { name: /09:00.*修复登录/ })
      .click();
    assert.equal(await title.innerText(), '修复登录');
    await located(first);
  });
  await page.screenshot({ path: path.join(evidence, 'navigation.png') });
  assert.deepEqual(errors, []);
  assert.equal(
    await readFile(path.join(home, 'records', `${day}.json`), 'utf8'),
    JSON.stringify(rows),
  );
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
await writeFile(
  path.join(root, 'reports/fix/timebar-direct-20261030/result.json'),
  JSON.stringify({ results, failures, errors }, null, 2),
);
console.log(JSON.stringify({ results, failures, errors }, null, 2));
assert.deepEqual(failures, []);
