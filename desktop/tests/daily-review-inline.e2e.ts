import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
const evidence = path.join(
  root,
  'reports/fix/daily-review-inline-20261104/evidence',
);
await mkdir(evidence, { recursive: true });
await mkdir(path.join(root, 'tmp'), { recursive: true });
await mkdir(path.join(root, 'logs'), { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/daily-inline-'));
const home = path.join(temporary, 'home');
const day = '2026-10-31';
const today = localDay();
const response = '【测试数据】已经保存的总结直接展示。\n\n完整正文保留换行。';
const target = path.join(home, 'daily-reviews', `${day}.json`);
await mkdir(path.dirname(target), { recursive: true });
await mkdir(path.join(home, 'summaries'), { recursive: true });
await symlink(path.join(root, '.venv'), path.join(temporary, '.venv'));
await symlink(path.join(root, 'src'), path.join(temporary, 'src'));
await writeFile(
  target,
  JSON.stringify({
    day,
    generatedAt: '2026-11-01T09:43:52+08:00',
    sourceCount: 1,
    sourceHash: 'a'.repeat(64),
    response,
  }),
);
const before = await readFile(target, 'utf8');
await writeFile(
  path.join(home, 'summaries', `${today}.json`),
  JSON.stringify([
    {
      windowStart: `${today}T09:00:00+08:00`,
      windowEnd: `${today}T09:30:00+08:00`,
      generatedAt: `${today}T09:31:00+08:00`,
      summary: '【测试数据】已保存的部分活动。',
      timeline: [],
      gaps: [],
    },
  ]),
);
const launcher = path.join(temporary, 'model.mjs');
const calls = path.join(temporary, 'calls.txt');
await writeFile(
  launcher,
  `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},'call\\n');setTimeout(()=>process.stdout.write('【测试数据】生成后的完整总结。'),500);`,
);
const config = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
config.set('home', home);
config.set('screenshotDir', path.join(temporary, 'snapshots'));
config.set('kmhLauncher', launcher);
config.setIn(['dailyReview', 'scheduledTime'], '23:59');
await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
const executable = process.env.DAILY_REVIEW_PACKAGE_PATH;
const app = await electron.launch({
  executablePath:
    executable ??
    path.join(
      desktop,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ),
  args: executable ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: temporary,
    OBSERVER_CONFIG: path.join(temporary, 'observer.yaml'),
  },
  timeout: 30000,
});
const results: string[] = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^(回顾|总结)$/, exact: true })
    .click();
  await page.getByRole('tab', { name: '每日总结', exact: true }).click();
  await page.getByLabel('选择日期').fill(day);
  const sheet = page.locator('.daily-archive-sheet');
  await sheet.getByText(response, { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '查看总结', exact: true }).count(),
    0,
  );
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await readFile(target, 'utf8'), before);
  assert.equal(await readFile(calls, 'utf8').catch(() => ''), '');
  await page.screenshot({
    path: path.join(root, 'tmp/daily-inline-saved.png'),
  });
  results.push('已有总结进入每日页直接显示原文，零模型调用，报告文件保持');
  const image = path.join(root, 'tmp/daily-inline-export.png');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath });
  }, image);
  await sheet.getByRole('button', { name: '保存图片', exact: true }).click();
  await sheet.getByRole('status').filter({ hasText: '图片已保存' }).waitFor();
  const png = await readFile(image);
  assert.equal(png.readUInt32BE(16), 1080);
  results.push('页内档案通过共用保存逻辑导出1080宽PNG');
  await page.getByLabel('选择日期').fill(today);
  await page.getByRole('button', { name: '生成总结', exact: true }).waitFor();
  assert.equal(await sheet.count(), 0);
  await page.screenshot({
    path: path.join(root, 'tmp/daily-inline-empty.png'),
  });
  results.push('缺总结显示生成总结按钮，当前日期已有部分分析也可手动生成');
  await page.getByRole('button', { name: '生成总结', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '当日档案', exact: true });
  await dialog
    .getByText('【测试数据】生成后的完整总结。', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await sheet
    .getByText('【测试数据】生成后的完整总结。', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('button', { name: '生成总结', exact: true }).count(),
    0,
  );
  results.push('手动生成复用统一弹窗，完成后每日页直接显示结果');
  await sheet.getByRole('button', { name: '重新生成', exact: true }).click();
  await dialog.getByRole('button', { name: '总结中', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '重新生成', exact: true }).waitFor();
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
  await page.keyboard.press('Escape');
  await sheet
    .getByText('【测试数据】生成后的完整总结。', { exact: true })
    .waitFor();
  results.push('页内重新生成调用同一生成流程，成功覆盖同日报告');
  await page.getByLabel('选择日期').fill(day);
  await sheet.getByText(response, { exact: true }).waitFor();
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await readFile(target, 'utf8'), before);
  results.push('日期切换直接读取对应报告，保留原文与日期归属');
  assert.deepEqual(errors, []);
  const coverage = await page.coverage.stopJSCoverage();
  await writeFile(
    path.join(
      evidence,
      executable ? 'package-coverage.json' : 'renderer-coverage.json',
    ),
    JSON.stringify(coverage),
  );
  if (!executable) {
    const assets = path.join(evidence, 'coverage/renderer');
    await mkdir(assets, { recursive: true });
    for (const entry of coverage) {
      if (
        !entry.url.startsWith('file:') ||
        !entry.url.includes('/out/renderer/assets/')
      )
        continue;
      const file = fileURLToPath(entry.url);
      await writeFile(
        path.join(assets, path.basename(file)),
        await readFile(file),
      );
      if (existsSync(file + '.map'))
        await writeFile(
          path.join(assets, path.basename(file) + '.map'),
          await readFile(file + '.map'),
        );
    }
  }
  await writeFile(
    path.join(evidence, executable ? 'package-e2e.json' : 'source-e2e.json'),
    JSON.stringify({ results, errors }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
