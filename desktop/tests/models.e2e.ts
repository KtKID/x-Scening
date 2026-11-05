import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { ModelCatalogSchema } from '../src/shared/models';

const root = path.resolve(import.meta.dirname, '../..');
const desktop = path.join(root, 'desktop');
const pictures = path.join(root, 'tmp/model-settings-preview');
const evidence = path.join(root, 'reports/model-settings-20261105/evidence');
await mkdir(pictures, { recursive: true });
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/model-window-'));
const config = path.join(temporary, 'observer.yaml');
const document = parseDocument(
  await readFile(path.join(root, 'observer.yaml'), 'utf8'),
);
document.set('home', path.join(temporary, 'home'));
document.set('screenshotDir', path.join(temporary, 'pictures'));
await writeFile(config, document.toString());
const catalog = ModelCatalogSchema.parse(
  JSON.parse(
    await readFile(
      path.join(desktop, '.cache/kmh-runtime/catalog.json'),
      'utf8',
    ),
  ),
);
const openai = catalog.catalog.find((entry) => entry.id === 'openai');
const model = openai?.models.find((entry) => entry.image);
assert.ok(model);
const testEnv = { ...process.env };
for (const provider of catalog.catalog)
  for (const name of provider.env) delete testEnv[name];
for (const name of Object.keys(testEnv))
  if (name.startsWith('SCENING_KEY_')) delete testEnv[name];
const app = await electron.launch({
  executablePath: path.join(
    desktop,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  ),
  args: [desktop],
  env: {
    ...testEnv,
    OBSERVER_PROJECT_ROOT: root,
    OBSERVER_CONFIG: config,
    ...(process.env.OBSERVER_TEST_COVERAGE === '1'
      ? { NODE_V8_COVERAGE: path.join(evidence, 'coverage/electron') }
      : {}),
  },
  timeout: 30000,
});
const observations: string[] = [];
try {
  const page = await app.firstWindow();
  if (process.env.OBSERVER_TEST_COVERAGE === '1')
    await page.coverage.startJSCoverage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const section = page.getByRole('region', { name: '模型设置', exact: true });
  await section.getByLabel('提供商', { exact: true }).waitFor();
  assert.deepEqual(
    await section
      .getByLabel('提供商', { exact: true })
      .locator('option')
      .allTextContents(),
    catalog.catalog.map((entry) => entry.id),
  );
  observations.push(`供应商目录与KMH逐项一致：${catalog.catalog.length}项。`);
  await section.getByLabel('提供商', { exact: true }).selectOption('openai');
  await section
    .getByLabel('供应商模型', { exact: true })
    .selectOption(model.id);
  await section
    .getByLabel('API 密钥', { exact: true })
    .fill('fixture-ui-secret');
  assert.equal(
    await section.getByLabel('API 密钥', { exact: true }).getAttribute('type'),
    'password',
  );
  await section
    .getByRole('button', { name: '保存供应商', exact: true })
    .click();
  await section
    .getByRole('status')
    .filter({ hasText: '供应商已保存' })
    .waitFor();
  await section.getByRole('button', { name: '编辑供应商 openai' }).click();
  assert.equal(
    await section.getByLabel('API 密钥', { exact: true }).inputValue(),
    '',
  );
  await section
    .getByRole('button', { name: '保存供应商', exact: true })
    .click();
  await section
    .getByRole('status')
    .filter({ hasText: '供应商已保存' })
    .waitFor();
  observations.push('密钥遮挡，保存后清空输入；编辑留空可保留原凭据。');
  const zai = catalog.catalog.find((entry) => entry.id === 'zai-coding-cn');
  const zaiModel = zai?.models.find((entry) => entry.image);
  assert.ok(zaiModel);
  await section
    .getByLabel('提供商', { exact: true })
    .selectOption('zai-coding-cn');
  await section
    .getByLabel('供应商模型', { exact: true })
    .selectOption(zaiModel.id);
  await section
    .getByLabel('API 密钥', { exact: true })
    .fill('fixture-zai-secret');
  await section
    .getByRole('button', { name: '保存供应商', exact: true })
    .click();
  await section
    .getByRole('status')
    .filter({ hasText: '供应商已保存' })
    .waitFor();
  await section
    .getByLabel('当前模型', { exact: true })
    .selectOption(JSON.stringify(['openai', model.id]));
  await section
    .getByRole('status')
    .filter({ hasText: '当前模型已更新' })
    .waitFor();
  assert.equal(
    await section.getByLabel('当前模型', { exact: true }).inputValue(),
    JSON.stringify(['openai', model.id]),
  );
  observations.push('两个已保存供应商展示状态，当前模型可跨供应商切换。');
  await page.screenshot({
    path: path.join(pictures, 'models-wide.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({
    path: path.join(pictures, 'models-narrow.png'),
    fullPage: true,
  });
  await section
    .getByRole('button', { name: '删除供应商 zai-coding-cn' })
    .click();
  await section
    .getByRole('status')
    .filter({ hasText: '供应商已删除' })
    .waitFor();
  assert.equal(
    await section
      .getByRole('button', { name: '编辑供应商 zai-coding-cn' })
      .count(),
    0,
  );
  await section.getByRole('tab', { name: '自定义模型 API' }).click();
  await section.getByLabel('自定义提供商名称').fill('local-gateway');
  await section.getByLabel('自定义 API 地址').fill('https://example.test/v1');
  await section.getByLabel('自定义模型名称').fill('vision-model');
  await section
    .getByRole('button', { name: '保存供应商', exact: true })
    .click();
  await section
    .getByRole('alert')
    .filter({ hasText: '请填写API密钥' })
    .waitFor();
  await section
    .getByLabel('API 密钥', { exact: true })
    .fill('fixture-custom-secret');
  await section
    .getByRole('button', { name: '保存供应商', exact: true })
    .click();
  await section
    .getByRole('status')
    .filter({ hasText: '供应商已保存' })
    .waitFor();
  await section
    .getByRole('button', { name: '编辑供应商 local-gateway' })
    .waitFor();
  observations.push('删除供应商和自定义API表单可用，操作完成后列表立即更新。');
  await page.locator('summary').filter({ hasText: '存储与高级设置' }).click();
  await page
    .getByLabel('活动与总结目录', { exact: true })
    .fill(path.join(temporary, 'next-home'));
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  await section.getByText('添加一个供应商，选择用于观察屏幕的模型。').waitFor();
  assert.equal(
    await section.getByRole('button', { name: '编辑供应商 openai' }).count(),
    0,
  );
  assert.equal(
    (await readFile(path.join(temporary, 'home/kmh/.env'), 'utf8')).includes(
      'fixture-ui-secret',
    ),
    true,
  );
  observations.push('切换数据目录后模型列表刷新为新目录状态，旧目录凭据保留。');
  assert.deepEqual(errors, []);
  if (process.env.OBSERVER_TEST_COVERAGE === '1') {
    const coverage = await page.coverage.stopJSCoverage();
    await writeFile(
      path.join(evidence, 'coverage/main-index.js.map'),
      await readFile(path.join(desktop, 'out/main/index.js.map')),
    );
    await writeFile(
      path.join(evidence, 'coverage/main-index.js'),
      await readFile(path.join(desktop, 'out/main/index.js')),
    );
    await writeFile(
      path.join(evidence, 'coverage/renderer-v8.json'),
      JSON.stringify(coverage),
    );
    for (const entry of coverage)
      if (entry.url.startsWith('file:') && entry.url.endsWith('.js')) {
        const file = new URL(entry.url);
        const map = await readFile(new URL(`${file.href}.map`), 'utf8');
        await writeFile(
          path.join(
            evidence,
            'coverage',
            `${path.basename(file.pathname)}.map`,
          ),
          map,
        );
      }
  }
  await writeFile(
    path.join(evidence, 'window.json'),
    JSON.stringify(
      { observations, pageErrors: errors, networkModelCalls: 0 },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(observations));
} finally {
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
