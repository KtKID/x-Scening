import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseEnv } from 'node:util';
import { parse, parseDocument } from 'yaml';
import { ModelSettingsService } from '../src/main/models';
import { SettingsService } from '../src/main/settings';
import { ModelSettingsSchema } from '../src/shared/models';
import type { SaveProvider } from '../src/shared/models';

const root = path.resolve(import.meta.dirname, '../..');
const request: SaveProvider = {
  provider: 'openai',
  kind: 'catalog',
  apiKey: 'test-secret-a',
  baseURL: '',
  api: '',
  model: 'fixture-vision',
  reasoningEffort: 'high',
};
const catalog = {
  source: 'KMH test boundary fixture',
  catalog: [
    {
      id: 'openai',
      baseURL: 'https://example.test/v1',
      env: ['OPENAI_API_KEY'],
      models: [
        {
          id: 'fixture-vision',
          name: 'Fixture Vision',
          image: true,
          efforts: ['low', 'high'],
        },
        { id: 'fixture-text', name: 'Fixture Text', image: false, efforts: [] },
      ],
    },
    {
      id: 'minimax-cn',
      baseURL: 'https://example.test/anthropic',
      env: ['MINIMAX_CN_API_KEY'],
      models: [
        { id: 'fixture-mini', name: 'Fixture Mini', image: true, efforts: [] },
      ],
    },
  ],
  protocols: ['openai-completions', 'anthropic-messages'],
  defaultSelection: { provider: 'minimax-cn', model: 'fixture-mini' },
  defaultProviders: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' } },
};

async function fixture(
  run: (
    service: ModelSettingsService,
    home: string,
    runtime: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(root, 'tmp/models-unit-'));
  try {
    const document = parseDocument(
      await readFile(path.join(root, 'observer.yaml'), 'utf8'),
    );
    const home = path.join(directory, 'home/kmh');
    document.set('home', path.dirname(home));
    const file = path.join(directory, 'observer.yaml');
    await writeFile(file, document.toString());
    const runtime = path.join(directory, 'runtime');
    await mkdir(runtime);
    await mkdir(home, { recursive: true });
    await writeFile(
      path.join(runtime, 'catalog.json'),
      JSON.stringify(catalog),
    );
    await run(
      new ModelSettingsService(new SettingsService(root, file), runtime, file),
      home,
      runtime,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test('models: 保存、重读、空密钥编辑与删除；界面只收到凭据状态', () =>
  fixture(async (service, home) => {
    assert.deepEqual((await service.read()).saved, []);
    const saved = await service.save(request);
    assert.equal(saved.saved.length, 1);
    assert.equal(saved.saved[0]?.credential, 'saved');
    assert.equal(saved.selected?.model, request.model);
    assert.equal(JSON.stringify(saved).includes('test-secret-a'), false);
    assert.equal((await stat(path.join(home, '.env'))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(path.join(home, 'observer-model.patch.yml'))).mode & 0o777,
      0o600,
    );
    const before = await readFile(path.join(home, '.env'), 'utf8');
    const edited = await service.save({
      ...request,
      apiKey: '',
      reasoningEffort: 'low',
      baseURL: 'https://example.test/proxy',
    });
    assert.equal(edited.selected?.reasoningEffort, 'low');
    assert.equal(await readFile(path.join(home, '.env'), 'utf8'), before);
    const removed = await service.remove('openai');
    assert.deepEqual(removed.saved, []);
    assert.equal(removed.selected, null);
    assert.equal(
      JSON.stringify(
        parseEnv(await readFile(path.join(home, '.env'), 'utf8')),
      ).includes('test-secret-a'),
      false,
    );
  }));

await test('models: 目录、图片能力、思考等级、密钥边界失败保留文件', () =>
  fixture(async (service, home) => {
    await service.save(request);
    const files = ['.env', 'observer-model.patch.yml'];
    const before = await Promise.all(
      files.map((file) => readFile(path.join(home, file), 'utf8')),
    );
    for (const invalid of [
      { ...request, provider: 'guessed-provider' },
      { ...request, model: 'guessed-model' },
      { ...request, model: 'fixture-text' },
      { ...request, reasoningEffort: 'imaginary' },
      { ...request, apiKey: 'key\nINJECT=secret' },
      { ...request, provider: '../bad' },
      { ...request, kind: 'custom' },
    ])
      await assert.rejects(service.save(invalid));
    assert.deepEqual(
      await Promise.all(
        files.map((file) => readFile(path.join(home, file), 'utf8')),
      ),
      before,
    );
    await assert.rejects(
      service.select({ provider: 'openai', model: 'fixture-text' }),
    );
    await assert.rejects(
      service.select({
        provider: 'openai',
        model: 'fixture-vision',
        reasoningEffort: 'imaginary',
      }),
    );
  }));

await test('models: 识别既有KMH凭据、自定义API、模型切换和删除后重读', () =>
  fixture(async (service, home) => {
    await writeFile(
      path.join(home, '.env'),
      '# existing\nMINIMAX_CN_API_KEY=legacy-test-secret\nOTHER=keep\n',
    );
    const legacy = await service.read();
    assert.equal(legacy.saved[0]?.provider, 'minimax-cn');
    assert.equal(legacy.saved[0]?.credential, 'saved');
    await service.save(request);
    await service.save({
      provider: 'my-gateway',
      kind: 'custom',
      apiKey: 'custom-test-secret',
      baseURL: 'https://example.test/v1',
      api: 'openai-completions',
      model: 'vision-model',
      reasoningEffort: '',
    });
    const switched = await service.select({
      provider: 'openai',
      model: 'fixture-vision',
      reasoningEffort: 'low',
    });
    assert.equal(switched.selected?.provider, 'openai');
    await service.remove('minimax-cn');
    assert.equal(
      (await service.read()).saved.some(
        (entry) => entry.provider === 'minimax-cn',
      ),
      false,
    );
    assert.equal(
      parseEnv(await readFile(path.join(home, '.env'), 'utf8')).OTHER,
      'keep',
    );
    const patchContent: unknown = parse(
      await readFile(path.join(home, 'observer-model.patch.yml'), 'utf8'),
    );
    assert.equal(
      JSON.stringify(patchContent).includes('custom-test-secret'),
      false,
    );
    ModelSettingsSchema.parse(await service.read());
  }));

await test('models: 串行保存保留所有供应商，读取坏文件明确失败', () =>
  fixture(async (service, home, runtime) => {
    await Promise.all([
      service.save(request),
      service.save({
        ...request,
        provider: 'minimax-cn',
        model: 'fixture-mini',
        reasoningEffort: '',
      }),
    ]);
    assert.equal((await service.read()).saved.length, 2);
    await writeFile(path.join(home, 'observer-model.patch.yml'), 'broken: [');
    await assert.rejects(service.read(), /模型配置读取失败/);
    await writeFile(path.join(runtime, 'catalog.json'), '{}');
    await assert.rejects(service.read());
  }));

await test('models: 模型补丁提交失败时恢复原凭据，首次保存失败移除新凭据文件', () =>
  fixture(async (service, home) => {
    await service.save(request);
    const before = await readFile(path.join(home, '.env'), 'utf8');
    const originalPatch = await readFile(
      path.join(home, 'observer-model.patch.yml'),
      'utf8',
    );
    // 在提交边界注入失败；.env的写入、恢复与清理继续经过真实文件系统。
    Object.defineProperty(service, 'commit', {
      value: () => Promise.reject(new Error('fixture patch write failure')),
    });
    await assert.rejects(
      service.save({ ...request, apiKey: 'replacement-secret' }),
      /fixture patch write failure/,
    );
    assert.equal(await readFile(path.join(home, '.env'), 'utf8'), before);
    assert.equal(
      await readFile(path.join(home, 'observer-model.patch.yml'), 'utf8'),
      originalPatch,
    );
    await rm(path.join(home, '.env'));
    await rm(path.join(home, 'observer-model.patch.yml'));
    await assert.rejects(service.save(request), /fixture patch write failure/);
    await assert.rejects(readFile(path.join(home, '.env')), { code: 'ENOENT' });
  }));
