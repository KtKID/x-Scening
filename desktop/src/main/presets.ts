import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { z } from 'zod';
import {
  PresetSnapshotSchema,
  TaskTypePresetsSchema,
} from '../shared/protocol';
import type { PresetSnapshot } from '../shared/protocol';

const MappingSchema = z.record(z.string(), z.unknown());

/** 桌面配置写入边界；只编辑预设字段，保留现有配置及中文注释。 */
export class PresetService {
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

  private async document() {
    const content = await readFile(this.configPath, 'utf8');
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length > 0)
      throw new Error(document.errors.map((error) => error.message).join('；'));
    if (!isMap(document.contents)) throw new Error('配置根内容应为字段映射');
    const values = MappingSchema.parse(document.toJS());
    return { content, document, values };
  }

  async read(): Promise<PresetSnapshot> {
    const { values } = await this.document();
    let taskTypes: unknown = values.taskTypes;
    if (!Object.hasOwn(values, 'taskTypes')) {
      const defaults = parseDocument(
        await readFile(path.join(this.root, 'observer.yaml'), 'utf8'),
        { uniqueKeys: true },
      );
      if (defaults.errors.length > 0)
        throw new Error(
          defaults.errors.map((error) => error.message).join('；'),
        );
      const raw: unknown = defaults.toJS();
      taskTypes = TaskTypePresetsSchema.strip().parse(raw).taskTypes;
    }
    return PresetSnapshotSchema.parse({
      taskTypes,
      configPath: this.configPath,
    });
  }

  save(raw: unknown): Promise<PresetSnapshot> {
    const operation = this.pending.then(() => this.write(raw));
    this.pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private async write(raw: unknown): Promise<PresetSnapshot> {
    const presets = TaskTypePresetsSchema.parse(raw);
    const { content, document, values } = await this.document();
    document.set('taskTypes', presets.taskTypes);
    const next =
      path.extname(this.configPath).toLowerCase() === '.json'
        ? `${JSON.stringify({ ...values, ...presets }, null, 2)}\n`
        : document.toString();
    const temporary = path.join(
      path.dirname(this.configPath),
      `.observer-presets-${randomUUID()}.tmp`,
    );
    const mode = (await stat(this.configPath)).mode;
    try {
      await writeFile(temporary, next, { flag: 'wx', mode });
      if ((await readFile(this.configPath, 'utf8')) !== content)
        throw new Error('配置已发生变化，请重新读取后保存');
      await rename(temporary, this.configPath);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success)
          return;
        throw error;
      });
    }
    return PresetSnapshotSchema.parse({
      ...presets,
      configPath: this.configPath,
    });
  }
}
