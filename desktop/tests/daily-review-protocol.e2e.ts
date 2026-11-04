import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
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

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'tmp/daily-review-single-protocol');
const report = path.join(root, 'reports/daily-review-single-protocol-20261103');
await mkdir(evidence, { recursive: true });
await mkdir(report, { recursive: true });
const executable =
  process.env.OBSERVER_PACKAGE_PATH ??
  path.join(
    desktop,
    'release/daily-review-single-protocol/mac-arm64/x-scening.app/Contents/MacOS/Observer',
  );
const day = '2026-10-31';
const response =
  '【测试数据】31号保存的完整日报告。\n\n读取完整字段并保持原文。';
const results: { hasMetadata: boolean; chars: number }[] = [];
const errors: string[] = [];
for (const hasMetadata of [false, true]) {
  const temporary = await mkdtemp(path.join(evidence, 'window-'));
  const home = path.join(temporary, 'home');
  await mkdir(path.join(home, 'daily-reviews'), { recursive: true });
  await symlink(path.join(root, '.venv'), path.join(temporary, '.venv'));
  await symlink(path.join(root, 'src'), path.join(temporary, 'src'));
  const config = parseDocument(
    await readFile(path.join(root, 'observer.yaml'), 'utf8'),
  );
  config.set('home', home);
  config.set('screenshotDir', path.join(temporary, 'snapshots'));
  config.set('kmhLauncher', path.join(temporary, 'unavailable-model.mjs'));
  await writeFile(path.join(temporary, 'observer.yaml'), config.toString());
  const row = {
    day,
    generatedAt: '2026-11-01T09:43:52+08:00',
    sourceCount: 16,
    sourceHash: 'a'.repeat(64),
    response,
    ...(hasMetadata
      ? { sourceActivityCount: 12, generationId: 'saved-generation-id' }
      : {}),
  };
  const saved = path.join(home, 'daily-reviews', `${day}.json`);
  await writeFile(saved, JSON.stringify(row));
  const before = await readFile(saved, 'utf8');
  const app = await electron.launch({
    executablePath: executable,
    args: executable.endsWith('/Electron.app/Contents/MacOS/Electron')
      ? [desktop]
      : [],
    env: {
      ...process.env,
      OBSERVER_PROJECT_ROOT: temporary,
      OBSERVER_CONFIG: path.join(temporary, 'observer.yaml'),
    },
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page
      .locator('.sidebar')
      .getByRole('button', { name: '回顾', exact: true })
      .click();
    await page.getByRole('tab', { name: '每日总结', exact: true }).click();
    await page.getByLabel('选择日期').fill(day);
    await page
      .locator('.review-prose')
      .getByText(response, { exact: true })
      .waitFor();
    assert.equal(await page.locator('.review-prose').textContent(), response);
    assert.equal(await page.getByLabel('选择日期').inputValue(), day);
    const reply = await page.evaluate(async (selectedDay) => {
      if (!window.observer) throw new Error('桌面读取接口缺失');
      return window.observer.readDailyReview({
        day: selectedDay,
        source: 'local',
        refresh: false,
        cachedOnly: true,
      });
    }, day);
    assert.equal(reply.status, 'ready');
    if (reply.status === 'ready') {
      assert.equal(reply.review.sourceActivityCount, hasMetadata ? 12 : null);
      assert.equal(
        reply.review.generationId,
        hasMetadata ? 'saved-generation-id' : null,
      );
    }
    assert.equal(await readFile(saved, 'utf8'), before);
    await page.screenshot({
      path: path.join(
        evidence,
        hasMetadata ? 'with-metadata.png' : 'saved-report.png',
      ),
    });
    results.push({ hasMetadata, chars: response.length });
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
assert.deepEqual(errors, []);
await writeFile(
  path.join(report, 'window.json'),
  JSON.stringify({ results, errors }, null, 2),
);
console.log(JSON.stringify({ results, errors }));
