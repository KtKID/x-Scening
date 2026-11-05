// 只读取KMH公开函数及scening配置，输出可重建的界面目录。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const source = process.argv[2];
const moduleOf = (file) =>
  import(
    pathToFileURL(
      path.join(source, 'third_party/dsh/packages/llm/llm-pi-ai/src', file),
    ).href
  );
const [catalog, metadata, models, provider] = await Promise.all([
  moduleOf('catalog.ts'),
  moduleOf('provider-data.ts'),
  moduleOf('models.ts'),
  moduleOf('provider.ts'),
]);
const patch = parseDocument(
  await readFile(
    path.join(source, 'profiles/scening/cordis.patch.yml'),
    'utf8',
  ),
  { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] },
).toJS();
const entries = patch.flatMap((row) => row.insert ?? []);
console.log(
  JSON.stringify({
    source: '@kmh/profile-scening + @deepseek-ai/dsh-llm-pi-ai',
    defaultSelection: entries.find((row) => row.id === 'agent-default-model')
      .config,
    defaultProviders: entries.find((row) => row.id === 'llm-pi-ai').config
      .providers,
    protocols: provider.supportedProtocols(),
    catalog: catalog.catalogProviderIds().map((id) => {
      const defaults = metadata.providerDefaultsOf(catalog.catalogProvider(id));
      return {
        id,
        env: defaults.nativeAuth?.env ?? [],
        baseURL: defaults.defaultBaseURL ?? '',
        models: [...catalog.catalogModels(id).values()].map((model) => ({
          id: model.id,
          name: model.name,
          image: model.input.includes('image'),
          efforts: model.reasoning
            ? models.getSupportedThinkingLevels(model)
            : [],
        })),
      };
    }),
  }),
);
