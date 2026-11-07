import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import {
  ModelCatalogSchema,
  ModelSelectionSchema,
  ModelSettingsSchema,
  ProviderIdSchema,
  SaveProviderSchema,
} from '../shared/models';
import type { ModelSelection, ModelSettings } from '../shared/models';
import type { SettingsService } from './settings';
import { resolveConfiguredPath } from './config-paths';

const ProfileSchema = z
  .object({
    apiKeyEnv: z.string().optional(),
    baseURL: z.string().optional(),
    api: z.string().optional(),
    models: z
      .array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          input: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
const RowsSchema = z.array(
  z.object({ id: z.string(), config: z.record(z.string(), z.unknown()) }),
);
const ProvidersSchema = z.record(z.string(), ProfileSchema);
const CodeSchema = z.object({ code: z.string() });

async function textFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error: unknown) {
    if (CodeSchema.safeParse(error).data?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicPrivate(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** KMH模型配置的唯一桌面写入口；目录来自内置资源，密钥始终留在主进程。 */
export class ModelSettingsService {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly settings: SettingsService,
    private readonly runtime: string,
    private readonly configPath: string,
  ) {}

  private async context(dataHome?: string) {
    const home = path.join(
      dataHome ??
        resolveConfiguredPath(
          this.configPath,
          (await this.settings.read()).config.home,
        ),
      'kmh',
    );
    const catalog = ModelCatalogSchema.parse(
      JSON.parse(
        await readFile(path.join(this.runtime, 'catalog.json'), 'utf8'),
      ),
    );
    const patchFile = path.join(home, 'observer-model.patch.yml');
    const content = await textFile(patchFile);
    let providers = ProvidersSchema.parse(catalog.defaultProviders);
    let selected: ModelSelection | null = catalog.defaultSelection;
    if (content !== undefined) {
      const document = parseDocument(content);
      if (document.errors.length)
        throw new Error('模型配置读取失败，请检查本地配置文件。');
      const rows = RowsSchema.parse(document.toJS());
      providers = ProvidersSchema.parse(
        rows.find((row) => row.id === 'llm-pi-ai')?.config.providers ?? {},
      );
      const selection = ModelSelectionSchema.safeParse(
        rows.find((row) => row.id === 'agent-default-model')?.config,
      );
      selected = selection.success ? selection.data : null;
    }
    const envFile = path.join(home, '.env');
    const envOriginal = await textFile(envFile);
    const envContent = envOriginal ?? '';
    const env = parseEnv(envContent);
    // 识别沿用的KMH .env；凭据值保持在主进程上下文内。
    if (content === undefined)
      for (const provider of catalog.catalog) {
        const reference = provider.env.find((name) => env[name]?.trim());
        if (reference && providers[provider.id] === undefined)
          providers[provider.id] = { apiKeyEnv: reference };
      }
    return {
      catalog,
      home,
      patchFile,
      providers,
      selected,
      envFile,
      envContent,
      envOriginal,
      env,
      configured: content !== undefined,
    };
  }

  async read(dataHome?: string): Promise<ModelSettings> {
    const context = await this.context(dataHome);
    const { catalog, providers, selected, env } = context;
    return ModelSettingsSchema.parse({
      catalog: catalog.catalog,
      protocols: catalog.protocols,
      selected,
      saved: Object.entries(providers).flatMap(([provider, profile]) => {
        const installed = catalog.catalog.find(
          (entry) => entry.id === provider,
        );
        const reference = profile.apiKeyEnv;
        const names = reference ? [reference] : (installed?.env ?? []);
        const credential = names.some((name) => env[name]?.trim())
          ? 'saved'
          : names.some((name) => process.env[name]?.trim())
            ? 'environment'
            : 'missing';
        if (!context.configured && credential === 'missing') return [];
        return [
          {
            provider,
            kind: installed ? 'catalog' : 'custom',
            credential,
            baseURL: profile.baseURL ?? installed?.baseURL ?? '',
            api: profile.api ?? '',
            models:
              installed?.models ??
              (profile.models ?? []).map((model) => ({
                id: model.id,
                name: model.name ?? model.id,
                image: model.input?.includes('image') ?? false,
                efforts: [],
              })),
          },
        ];
      }),
    });
  }

  /** 采集启动和开启分析前复用模型设置的凭据状态，仅检查本地配置。 */
  async requireImageModel(dataHome?: string): Promise<void> {
    await this.pending;
    const { selected, saved } = await this.read(dataHome);
    const provider = saved.find(
      (entry) => entry.provider === selected?.provider,
    );
    if (
      !provider ||
      provider.credential === 'missing' ||
      !provider.models.some(
        (model) => model.id === selected?.model && model.image,
      )
    )
      throw new Error(
        '图片分析模型还没配置。请在「设置 → 模型」选择支持图片的模型并保存 API 密钥。',
      );
  }

  private serialize(
    operation: () => Promise<ModelSettings>,
  ): Promise<ModelSettings> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async commit(
    context: Awaited<ReturnType<ModelSettingsService['context']>>,
  ): Promise<ModelSettings> {
    await atomicPrivate(
      context.patchFile,
      stringify([
        { id: 'llm-pi-ai', config: { providers: context.providers } },
        {
          id: 'agent-default-model',
          config: context.selected ?? { provider: '', model: '' },
        },
      ]),
    );
    return this.read();
  }

  save(raw: unknown): Promise<ModelSettings> {
    return this.serialize(async () => {
      const request = SaveProviderSchema.parse(raw);
      const context = await this.context();
      const installed = context.catalog.catalog.find(
        (entry) => entry.id === request.provider,
      );
      if (request.kind === 'catalog' && !installed)
        throw new Error('请选择KMH目录中的供应商。');
      if (request.kind === 'custom' && installed)
        throw new Error('此名称属于KMH供应商，请使用第三方模型表单。');
      const model = installed?.models.find(
        (entry) => entry.id === request.model,
      );
      if (request.kind === 'catalog' && (!model || !model.image))
        throw new Error('请选择目录中支持图片的模型。');
      if (
        request.reasoningEffort &&
        !model?.efforts.includes(request.reasoningEffort)
      )
        throw new Error('请选择模型提供的思考等级。');
      if (
        request.kind === 'custom' &&
        (!request.baseURL || !context.catalog.protocols.includes(request.api))
      )
        throw new Error('请填写API地址并选择KMH支持的协议。');
      const previous = context.providers[request.provider] ?? {};
      const managedReference = `SCENING_KEY_${createHash('sha256').update(request.provider).digest('hex').slice(0, 16).toUpperCase()}`;
      const reference = request.apiKey.trim()
        ? managedReference
        : (previous.apiKeyEnv ?? managedReference);
      const available =
        context.env[reference] ||
        process.env[reference] ||
        installed?.env.some((name) => context.env[name] || process.env[name]);
      if (!request.apiKey.trim() && !available)
        throw new Error('请填写API密钥，或配置供应商所需的环境认证。');
      if (request.apiKey.trim()) {
        // 同名环境行统一替换；其他注释和用户凭据保持原文。
        const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lines = context.envContent
          .split(/\r?\n/)
          .filter(
            (line) =>
              !new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`).test(line),
          );
        await atomicPrivate(
          context.envFile,
          `${lines.join('\n').trimEnd()}\n${reference}=${JSON.stringify(request.apiKey.trim())}\n`,
        );
      }
      const profile = { ...previous };
      if (request.apiKey.trim() || previous.apiKeyEnv)
        profile.apiKeyEnv = reference;
      if (request.baseURL) profile.baseURL = request.baseURL;
      else delete profile.baseURL;
      if (request.kind === 'custom') {
        profile.api = request.api;
        profile.models = [
          { id: request.model, name: request.model, input: ['text', 'image'] },
        ];
      }
      context.providers[request.provider] = profile;
      // 首次配置从有凭据的供应商建立有效集合，避免附带未配置的默认供应商。
      if (!context.configured)
        for (const [id, value] of Object.entries(context.providers)) {
          if (id === request.provider) continue;
          const metadata = context.catalog.catalog.find(
            (entry) => entry.id === id,
          );
          const names = value.apiKeyEnv
            ? [value.apiKeyEnv]
            : (metadata?.env ?? []);
          if (!names.some((name) => context.env[name] || process.env[name]))
            delete context.providers[id];
        }
      if (
        !context.selected ||
        context.selected.provider === request.provider ||
        !Object.hasOwn(context.providers, context.selected.provider)
      ) {
        context.selected = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort
            ? { reasoningEffort: request.reasoningEffort }
            : {}),
        };
      }
      try {
        return await this.commit(context);
      } catch (error: unknown) {
        // 补丁提交失败时恢复原凭据文件，保持用户最近成功保存的配置。
        if (request.apiKey.trim()) {
          if (context.envOriginal === undefined)
            await rm(context.envFile, { force: true });
          else await atomicPrivate(context.envFile, context.envOriginal);
        }
        throw error;
      }
    });
  }

  select(raw: unknown): Promise<ModelSettings> {
    return this.serialize(async () => {
      const selected = ModelSelectionSchema.parse(raw);
      const snapshot = await this.read();
      const provider = snapshot.saved.find(
        (entry) => entry.provider === selected.provider,
      );
      const model = provider?.models.find(
        (entry) => entry.id === selected.model && entry.image,
      );
      if (!model || provider?.credential === 'missing')
        throw new Error('请先保存供应商密钥并选择支持图片的模型。');
      if (
        selected.reasoningEffort &&
        !model.efforts.includes(selected.reasoningEffort)
      )
        throw new Error('请选择模型提供的思考等级。');
      const context = await this.context();
      context.selected = selected;
      return this.commit(context);
    });
  }

  remove(raw: unknown): Promise<ModelSettings> {
    return this.serialize(async () => {
      const provider = ProviderIdSchema.parse(raw);
      const context = await this.context();
      delete context.providers[provider];
      if (context.selected?.provider === provider) context.selected = null;
      // 先移除运行路由，再清除本设置页创建的专用凭据；现有共享凭据由用户管理。
      const snapshot = await this.commit(context);
      const reference = `SCENING_KEY_${createHash('sha256').update(provider).digest('hex').slice(0, 16).toUpperCase()}`;
      const lines = context.envContent
        .split(/\r?\n/)
        .filter((line) => !line.startsWith(`${reference}=`));
      if (lines.join('\n') !== context.envContent)
        await atomicPrivate(context.envFile, lines.join('\n'));
      return snapshot;
    });
  }
}
