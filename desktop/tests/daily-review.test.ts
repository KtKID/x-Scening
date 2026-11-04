import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { DailyReviewService } from '../src/main/daily-review';
import { DailyReviewQuerySchema } from '../src/shared/protocol';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const day = '2026-10-28';

await test('T3/T5 demo stays in memory and query calendar is validated', async () => {
  const service = new DailyReviewService('/directory-that-does-not-exist');
  const reply = await service.read({ day, source: 'demo', refresh: false });
  assert.equal(reply.status, 'ready');
  if (reply.status === 'ready')
    assert.ok(reply.review.response.startsWith('【测试数据】'));
  for (const value of ['../2026-10-28', '2026-02-30', '20261028']) {
    assert.equal(
      DailyReviewQuerySchema.safeParse({
        day: value,
        source: 'local',
        refresh: false,
      }).success,
      false,
    );
  }
});

await test('T1/T2/T4 actual Python bridge generates, coalesces, caches and preserves a failed update', async () => {
  const parent = path.join(root, 'tmp/daily-review');
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'service-'));
  const home = path.join(folder, 'home');
  const previousPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    await mkdir(path.join(home, 'summaries'), { recursive: true });
    const launcher = path.join(folder, 'model.mjs');
    await writeFile(
      launcher,
      `import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const folder = import.meta.dirname;
appendFileSync(path.join(folder, 'calls.txt'), 'call\\n');
const response = readFileSync(path.join(folder, 'reply.txt'), 'utf8');
if (response === 'FAIL') process.exit(2);
process.stdout.write(response);`,
    );
    await writeFile(
      path.join(folder, 'reply.txt'),
      '今天你在推进采集模块。每次定位都在积累进展。\n\n辛苦了，记得休息。',
    );
    const config = parseDocument(
      await readFile(path.join(root, 'observer.yaml'), 'utf8'),
    );
    config.set('home', home);
    config.set('screenshotDir', path.join(folder, 'snapshots'));
    config.set('kmhLauncher', launcher);
    const configPath = path.join(folder, 'observer.yaml');
    await writeFile(configPath, config.toString());
    const sourcePath = path.join(home, 'summaries', `${day}.json`);
    const source = JSON.stringify([
      {
        windowStart: `${day}T09:00:00+08:00`,
        windowEnd: `${day}T09:30:00+08:00`,
        generatedAt: `${day}T09:31:00+08:00`,
        summary: '推进采集模块，正在定位启动问题。',
        timeline: [],
        gaps: [],
        trigger: 'periodic',
      },
    ]);
    await writeFile(sourcePath, source);
    const service = new DailyReviewService(root, configPath);
    const query = { day, source: 'local' as const, refresh: false };
    const first = service.read(query);
    const second = service.read(query);
    assert.equal(first, second);
    const result = await first;
    assert.equal(result.status, 'ready', JSON.stringify(result));
    if (result.status === 'ready') {
      assert.match(result.review.response, /今天你在推进采集模块/);
      assert.equal(result.review.sourceActivityCount, 0);
      assert.ok(result.review.generationId);
    }
    assert.equal(await readFile(sourcePath, 'utf8'), source);
    assert.equal(
      (await readFile(path.join(folder, 'calls.txt'), 'utf8')).trim(),
      'call',
    );
    await writeFile(path.join(folder, 'reply.txt'), 'FAIL');
    assert.deepEqual(await service.read(query), result);
    const savedPath = path.join(home, 'daily-reviews', `${day}.json`);
    const saved = await readFile(savedPath, 'utf8');
    const failed = await service.read({ ...query, refresh: true });
    assert.equal(failed.status, 'error');
    assert.equal(await readFile(savedPath, 'utf8'), saved);
    const empty = await service.read({ ...query, day: '2026-10-27' });
    assert.equal(empty.status, 'empty');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(folder, { recursive: true, force: true });
  }
});
