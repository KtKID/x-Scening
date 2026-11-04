import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isMap, parseDocument } from 'yaml';
import { z } from 'zod';
import {
  EditableConfigSchema,
  SaveSettingsSchema,
  SettingsSnapshotSchema,
} from '../shared/protocol';
import type { EditableConfig, SettingsSnapshot } from '../shared/protocol';
import { settingLabel } from '../shared/settings';
import { withReason } from './diagnostics';

const execute = promisify(execFile);
const MappingSchema = z.record(z.string(), z.unknown());
const ValidationIssuesSchema = z.array(
  z.strictObject({ field: z.string(), message: z.string() }),
);
const digest = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

// 直接调用运行时权威模型，包含 JSON Schema 中未表达的跨字段校验。
const validateConfig = `import json, sys
from pydantic import ValidationError
from scening.observer_config import ObserverConfig
try:
    ObserverConfig.model_validate(json.loads(sys.argv[1]))
    print('[]')
except ValidationError as error:
    print(json.dumps([{'field': '.'.join(str(part) for part in item['loc']), 'message': item['msg']} for item in error.errors()]))
`;

/** 统一配置读写；页面提供原文版本，主进程独占临时提交并保留 YAML 注释。 */
export class SettingsService {
  private readonly configPath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    configPath?: string,
  ) {
    this.configPath = path.resolve(
      configPath ?? path.join(root, 'observer.yaml'),
    );
  }

  private async document(source = this.configPath) {
    const content = await readFile(source, 'utf8');
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length)
      throw new Error(
        `配置读取失败：${document.errors.map((error) => error.message).join('；')}`,
      );
    if (!isMap(document.contents)) throw new Error('配置根内容应为字段映射。');
    return { content, document, values: MappingSchema.parse(document.toJS()) };
  }

  async read(): Promise<SettingsSnapshot> {
    const { content, values } = await this.document();
    const defaults = (
      await this.document(path.join(this.root, 'observer.yaml'))
    ).values;
    // 与 Python 旧配置兼容规则一致；桌面刷新配置使用项目 YAML 的默认块。
    for (const key of [
      'scening',
      'analysis',
      'control',
      'dailyReview',
      'taskTypes',
      'taskTimeline',
    ])
      if (!Object.hasOwn(values, key)) values[key] = defaults[key];
    values.desktop ??= defaults.desktop;
    const normalized = await execute(
      path.join(this.root, '.venv/bin/python'),
      [
        '-B',
        '-c',
        'import json,sys; from scening.observer_config import DailyReviewConfig; print(DailyReviewConfig.model_validate(json.loads(sys.argv[1])).model_dump_json())',
        JSON.stringify(values.dailyReview),
      ],
      {
        cwd: this.root,
        env: { ...process.env, PYTHONPATH: path.join(this.root, 'src') },
      },
    );
    const daily: unknown = JSON.parse(normalized.stdout);
    values.dailyReview = daily;

    const config = EditableConfigSchema.parse(
      Object.fromEntries(
        Object.entries(values).filter(([key]) => key !== '_comments'),
      ),
    );
    return SettingsSnapshotSchema.parse({ config, revision: digest(content) });
  }

  save(raw: unknown): Promise<SettingsSnapshot> {
    const operation = this.pending.then(() => this.write(raw));
    this.pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private async validate(config: EditableConfig): Promise<void> {
    const python = path.join(
      this.root,
      process.platform === 'win32'
        ? '.venv/Scripts/python.exe'
        : '.venv/bin/python',
    );
    let output: string;
    try {
      const result = await execute(
        python,
        ['-B', '-c', validateConfig, JSON.stringify(config)],
        {
          cwd: this.root,
          env: { ...process.env, PYTHONPATH: path.join(this.root, 'src') },
        },
      );
      output = result.stdout;
    } catch (error: unknown) {
      throw new Error(withReason('配置校验暂时无法完成', error));
    }
    const raw: unknown = JSON.parse(output);
    const issues = ValidationIssuesSchema.parse(raw);
    if (issues.length)
      throw new Error(
        issues
          .map((issue) => {
            if (
              issue.field === 'analysis' &&
              issue.message.includes('labelHeight')
            )
              return '分析拼图：时间标签高度须至少等于时间标签字号。';
            if (
              issue.field === 'analysis' &&
              issue.message.includes('maxImagePixels')
            )
              return '分析拼图超出像素上限，请缩小每帧尺寸或调大拼图像素上限。';
            return `${settingLabel(issue.field)}：${issue.message.replace(/^Value error, /, '')}`;
          })
          .join('；'),
      );
  }

  private async write(raw: unknown): Promise<SettingsSnapshot> {
    const request = SaveSettingsSchema.parse(raw);
    const { content, document } = await this.document();
    if (digest(content) !== request.revision)
      throw new Error('配置已发生变化，请重新读取后保存。');
    await this.validate(request.config);
    for (const [key, value] of Object.entries(request.config)) {
      if (Array.isArray(value) || value === null || typeof value !== 'object')
        document.set(key, value);
      else
        for (const [child, entry] of Object.entries(value))
          document.setIn([key, child], entry);
    }
    const next =
      path.extname(this.configPath).toLowerCase() === '.json'
        ? `${JSON.stringify(document.toJS(), null, 2)}\n`
        : document.toString();
    const temporary = path.join(
      path.dirname(this.configPath),
      `.observer-settings-${randomUUID()}.tmp`,
    );
    const mode = (await stat(this.configPath)).mode;
    try {
      await writeFile(temporary, next, { flag: 'wx', mode });
      if ((await readFile(this.configPath, 'utf8')) !== content)
        throw new Error('配置已发生变化，请重新读取后保存。');
      await rename(temporary, this.configPath);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success)
          return;
        throw error;
      });
    }
    return SettingsSnapshotSchema.parse({
      config: request.config,
      revision: digest(next),
    });
  }
}
