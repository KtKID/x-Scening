import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { localDay, moveDay } from '../src/shared/protocol';
import {
  fixture,
  callCount,
  eventually,
  root,
  desktop,
  evidence,
} from './backfill-fixture';

const f = await fixture();
const screenshots = path.join(root, 'tmp/desktop-backfill-preview');
await mkdir(screenshots, { recursive: true });
await mkdir(evidence, { recursive: true });
const originals = await Promise.all(
  (await readdir(f.shots)).map(async (name) => ({
    name,
    bytes: await readFile(path.join(f.shots, name)),
  })),
);
const packaged = process.env.BACKFILL_PACKAGED === '1';
const results: string[] = [];
const errors: string[] = [];
const application = await electron.launch({
  executablePath: path.join(
    desktop,
    packaged
      ? 'release/mac-arm64/x-scening.app/Contents/MacOS/Observer'
      : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  ),
  args: packaged ? [] : [desktop],
  env: {
    ...process.env,
    OBSERVER_PROJECT_ROOT: f.folder,
    OBSERVER_CONFIG: f.configPath,
  },
  timeout: 30000,
});
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '整理', exact: true }).click();
  const panel = page.getByRole('region', { name: '补分析页面' });
  const date = panel.getByLabel('补分析日期');
  await panel.getByText('待补分析', { exact: true }).waitFor();
  assert.equal(await date.inputValue(), f.day);
  assert.equal(await panel.getByRole('button').count(), 2);
  const action = panel.locator('.backfill-action-row').getByRole('button');
  assert.equal(await callCount(f.folder), 0);
  assert.match(
    (await panel.locator('.backfill-source .pipeline-value').textContent()) ??
      '',
    /5\s*张/,
  );
  assert.equal(
    await panel.locator('.backfill-result .pipeline-detail').innerText(),
    '待分析 5 张',
  );
  results.push(
    '默认昨天，真实核对5张待分析，页面仅一个操作按钮，查看保持零模型调用。',
  );
  await date.fill(moveDay(f.day, -2));
  await panel.getByRole('heading', { name: '这一天暂无截图' }).waitFor();
  assert.equal(await action.isDisabled(), true);
  await date.fill(localDay());
  await panel.getByRole('heading', { name: '这一天暂无截图' }).waitFor();
  await date.fill(moveDay(localDay(), 1));
  await panel
    .getByText('补分析支持今天和历史日期，请选择今天或更早日期。')
    .waitFor();
  assert.equal(await action.isDisabled(), true);
  assert.equal(await callCount(f.folder), 0);
  results.push('空日期与今天可核对，空日期和未来日期执行禁用，模型调用仍为0。');
  await date.fill(f.day);
  await writeFile(path.join(f.folder, 'mode.txt'), 'fail');
  await panel.getByRole('heading', { name: '待补分析', exact: true }).waitFor();
  await panel.getByRole('button', { name: '开始补分析', exact: true }).click();
  await panel.getByRole('heading', { name: '还有截图待分析' }).waitFor();
  assert.equal(await callCount(f.folder), 2);
  await writeFile(path.join(f.folder, 'mode.txt'), 'success');
  await panel.getByRole('button', { name: '继续补分析' }).click();
  await eventually(async () => (await callCount(f.folder)) === 3);
  await writeFile(path.join(f.folder, 'mode.txt'), 'slow');
  await eventually(async () => (await callCount(f.folder)) === 4);
  await panel.getByText('本轮已保存 3 / 5 张').waitFor();
  assert.equal(await date.isDisabled(), true);
  await page.screenshot({ path: path.join(screenshots, 'running.png') });
  await panel.getByRole('button', { name: '停止补分析' }).click();
  await panel.getByRole('heading', { name: '已停止', exact: true }).waitFor();
  assert.match(
    (await panel.locator('.backfill-result .pipeline-value').textContent()) ??
      '',
    /3\s*\/ 5 张/,
  );
  assert.equal(
    await panel.locator('.backfill-result .pipeline-detail').innerText(),
    '待分析 2 张',
  );
  results.push(
    '模型失败提示继续；恢复后第一批真实保存3张，第二批停止，3张成功结果保留、剩余2张。',
  );
  await writeFile(path.join(f.folder, 'mode.txt'), 'success');
  await panel.getByRole('button', { name: '继续补分析' }).click();
  await page.getByRole('button', { name: '回顾', exact: true }).first().click();
  await eventually(async () => (await callCount(f.folder)) === 5);
  await page.getByRole('button', { name: '整理', exact: true }).click();
  await panel
    .getByRole('heading', { name: '全部已分析', exact: true })
    .waitFor();
  assert.equal(await action.isDisabled(), true);
  assert.match(
    (await panel.locator('.backfill-result .pipeline-value').textContent()) ??
      '',
    /5\s*\/ 5 张/,
  );
  assert.equal(
    await panel.locator('.backfill-result .pipeline-detail').innerText(),
    '待分析 0 张',
  );
  assert.equal(await callCount(f.folder), 5);
  for (const original of originals)
    assert.deepEqual(
      await readFile(path.join(f.shots, original.name)),
      original.bytes,
    );
  results.push(
    '切换Tab继续后台处理，两张尾批补齐，5张全部分析，原图字节保持一致。',
  );
  await page.screenshot({ path: path.join(screenshots, 'completed.png') });
  await page.setViewportSize({ width: 850, height: 720 });
  assert.equal(await action.isVisible(), true);
  assert.equal(await panel.getByLabel('补分析日期').isVisible(), true);
  assert.equal(await page.locator('.inspector').isVisible(), false);
  await page.screenshot({ path: path.join(screenshots, 'narrow.png') });
  results.push('850像素窗口日期、按钮、数量均可见，右侧详情收起。');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /测试预览.*使用标有/ }).click();
  await page.getByRole('button', { name: '整理', exact: true }).click();
  await panel
    .getByRole('heading', { name: '全部已分析', exact: true })
    .waitFor();
  await panel.getByText('让截图成为活动，让活动串成任务').waitFor();
  assert.equal(await callCount(f.folder), 5);
  results.push(
    '测试预览切换后，独立补分析页仍明确读取本地截图，日期保留，查看零额外模型调用。',
  );
  // 新增原图后重新核对，证明完成状态随正式来源变化；退出走真实before-quit。
  const original = originals[0];
  assert.ok(original);
  await copyFile(
    path.join(f.shots, original.name),
    path.join(f.shots, `${f.day}_10-00-00_m1_action.jpg`),
  );
  await panel.getByRole('heading', { name: '待补分析', exact: true }).waitFor();
  await writeFile(path.join(f.folder, 'mode.txt'), 'slow');
  await panel.getByRole('button', { name: '开始补分析' }).click();
  await eventually(async () => (await callCount(f.folder)) === 6);
  await application.evaluate(({ app }) => {
    app.quit();
  });
  await eventually(async () => {
    const raw: unknown = JSON.parse(
      await readFile(
        path.join(f.home, 'backfill', f.day, 'latest.json'),
        'utf8',
      ),
    );
    return (
      (
        await import('../src/shared/scening.generated')
      ).BackfillStatusSchema.pick({ state: true })
        .strip()
        .safeParse(raw).data?.state === 'cancelled'
    );
  });
  results.push(
    '新增原图使完成状态恢复为待补分析；应用退出取消在途模型并记录cancelled，成功结果保留。',
  );
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await application.close();
  await rm(f.folder, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
const output = {
  packaged,
  results,
  count: results.length,
  errors,
  model:
    '仅模型启动器为受控替身；真实Electron/IPC/Python/拼图/正式报告/索引/退出',
};
await writeFile(
  path.join(evidence, packaged ? 'packaged-electron.json' : 'electron.json'),
  JSON.stringify(output, null, 2),
);
console.log(JSON.stringify(output, null, 2));
