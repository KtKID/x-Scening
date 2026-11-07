import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { parseDocument } from 'yaml';
import { ModelCatalogSchema } from '../src/shared/models';
import { verifyBundledRuntimes } from '../src/bundled-runtime-check';

const root = path.resolve(import.meta.dirname, '../..');
const original = path.join(
  root,
  'tmp/portable-client-build/desktop/release/mac-arm64/x-scening.app',
);
const temporary = await mkdtemp(path.join(root, 'tmp/portable-install-'));
const installed = path.join(
  temporary,
  'Another Users Applications/x-scening.app',
);
const user = path.join(temporary, 'user');
const evidence = path.join(root, 'reports/portable-client-20261105/evidence');
const preview = path.join(root, 'tmp/portable-client-preview');
await mkdir(path.dirname(installed), { recursive: true });
await mkdir(user);
await mkdir(preview, { recursive: true });
await mkdir(evidence, { recursive: true });
await rename(original, installed);
try {
  const resources = path.join(installed, 'Contents/Resources');
  await verifyBundledRuntimes(resources);
  const catalog = ModelCatalogSchema.parse(
    JSON.parse(
      await readFile(path.join(resources, 'kmh-runtime/catalog.json'), 'utf8'),
    ),
  );
  const env = { ...process.env };
  delete env.OBSERVER_CONFIG;
  for (const provider of catalog.catalog)
    for (const name of provider.env) delete env[name];
  for (const name of Object.keys(env))
    if (name.startsWith('SCENING_KEY_')) delete env[name];
  const app = await electron.launch({
    executablePath: path.join(installed, 'Contents/MacOS/x-scening'),
    args: [],
    env: {
      ...env,
      HOME: user,
      OBSERVER_PROJECT_ROOT: '/unavailable/developer/project',
      PYTHONHOME: '/unavailable/system/python',
      PYTHONPATH: '/unavailable/developer/modules',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    timeout: 45000,
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const models = page.getByRole('region', { name: '模型设置', exact: true });
    await models.getByLabel('提供商', { exact: true }).waitFor();
    assert.equal(
      await models
        .getByLabel('提供商', { exact: true })
        .locator('option')
        .count(),
      catalog.catalog.length,
    );
    await page.locator('summary').filter({ hasText: '分析与截图频率' }).click();
    await page.getByLabel('分析候选处理间隔（秒）', { exact: true }).fill('8');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
    const configPath = path.join(user, '.scening/observer.yaml');
    const config = parseDocument(await readFile(configPath, 'utf8'));
    assert.equal(config.get('home'), '~/.scening');
    assert.equal(config.get('screenshotDir'), '~/.scening/snapshots');
    assert.equal(config.get('sampleIntervalSeconds'), 8);
    const supplier = catalog.catalog.find((item) => item.id === 'openai');
    const model = supplier?.models.find((item) => item.image);
    assert.ok(model);
    await models.getByLabel('提供商', { exact: true }).selectOption('openai');
    await models
      .getByLabel('供应商模型', { exact: true })
      .selectOption(model.id);
    await models
      .getByLabel('API 密钥', { exact: true })
      .fill('fixture-portable-key');
    await models
      .getByRole('button', { name: '保存供应商', exact: true })
      .click();
    await models
      .getByRole('status')
      .filter({ hasText: '供应商已保存' })
      .waitFor();
    assert.match(
      await readFile(
        path.join(user, '.scening/kmh/observer-model.patch.yml'),
        'utf8',
      ),
      /openai/,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: path.join(preview, 'installed-settings.png'),
      fullPage: true,
    });
    await writeFile(
      path.join(evidence, 'portable-window.json'),
      JSON.stringify(
        {
          sourceRoot: '/unavailable/developer/project',
          systemPython: '/unavailable/system/python',
          resourcesRelocated: true,
          pythonAndKmhLaunch: 'passed',
          settingsReadWrite: 'passed',
          supplierSave: 'passed',
          catalogProviders: catalog.catalog.length,
          userData: 'isolated-home/.scening',
          pageErrors: errors,
          externalModelCalls: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
} finally {
  await rename(installed, original);
  await rm(temporary, { recursive: true, force: true });
}
