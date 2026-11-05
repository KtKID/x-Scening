import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  ActivityEventSchema,
  ActivitySummarySchema,
  ObserverConfigSchema,
} from '../shared/scening.generated';
import { DaySchema, SnapshotSchema } from '../shared/protocol';
import type { Snapshot, ImageResult } from '../shared/protocol';
import { cardTitle } from '../shared/presentation';
import { resolveConfiguredPath } from './config-paths';

// 位置只是原配置的读取投影，字段类型由 Python 模型的生成契约提供。
const LocationsSchema = ObserverConfigSchema.pick({
  home: true,
  screenshotDir: true,
}).strip();
const ErrorCodeSchema = z.object({ code: z.string() }).passthrough();
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '读取失败';
}

async function readList<T>(
  target: string,
  parse: (value: unknown) => T[],
): Promise<{ rows: T[]; issue: string | null; revision: string }> {
  try {
    const content = await readFile(target, 'utf8');
    const raw: unknown = JSON.parse(content);
    return {
      rows: parse(raw),
      issue: null,
      revision: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if (ErrorCodeSchema.safeParse(error).data?.code === 'ENOENT')
      return { rows: [], issue: null, revision: '' };
    return {
      rows: [],
      revision: '',
      issue: `${path.basename(target)}：${errorMessage(error)}`,
    };
  }
}

/** 从当前配置解析数据位置，供日记录及截图目录操作共享。 */
export async function readLocalLocations(configPath: string) {
  const document = parseDocument(await readFile(configPath, 'utf8'), {
    uniqueKeys: true,
  });
  if (document.errors.length > 0)
    throw new Error(document.errors.map((error) => error.message).join('；'));
  const raw: unknown = document.toJS();
  const configured = LocationsSchema.parse(raw);
  if (!configured.home.trim() || !configured.screenshotDir.trim())
    throw new Error('数据目录应有内容');
  return {
    configPath,
    home: resolveConfiguredPath(configPath, configured.home),
    screenshotDir: resolveConfiguredPath(configPath, configured.screenshotDir),
  };
}

/** 只读配置与完整的按日 JSON；活动和总结分别处理错误，保存操作保持零次。 */
export async function readLocalDay(
  root: string,
  day: string,
  configPath = path.join(root, 'observer.yaml'),
): Promise<Snapshot> {
  DaySchema.parse(day);
  const snapshot: Snapshot = {
    day,
    source: 'local',
    sourceRevision: '',
    activities: [],
    summaries: [],
    issues: [],
    locations: { configPath, home: '', screenshotDir: '' },
  };
  try {
    snapshot.locations = await readLocalLocations(configPath);
    const { home } = snapshot.locations;
    const [activities, summaries] = await Promise.all([
      readList(path.join(home, 'records', `${day}.json`), (value) => {
        const rows = z.array(z.unknown()).parse(value);
        return rows.flatMap((raw, index) => {
          const parsed = ActivityEventSchema.safeParse(raw);
          if (
            !parsed.success ||
            !parsed.data.analysis.trim() ||
            parsed.data.start.slice(0, 10) !== day ||
            parsed.data.end.slice(0, 10) !== day ||
            Date.parse(parsed.data.end) < Date.parse(parsed.data.start)
          ) {
            snapshot.issues.push(`活动第${String(index + 1)}条无法读取`);
            return [];
          }
          const row = parsed.data;
          return [
            {
              ...row,
              id: createHash('sha256')
                .update(`${day}:${String(index)}:${row.start}`)
                .digest('hex')
                .slice(0, 24),
              title: cardTitle(row.analysis),
            },
          ];
        });
      }),
      readList(path.join(home, 'summaries', `${day}.json`), (value) => {
        const rows = z.array(ActivitySummarySchema).parse(value);
        for (const row of rows) {
          if (
            !row.summary.trim() ||
            Date.parse(row.windowEnd) <= Date.parse(row.windowStart) ||
            row.windowEnd.slice(0, 10) !== day
          )
            throw new Error('总结日期、窗口或正文无效');
        }
        return rows;
      }),
    ]);
    snapshot.activities = activities.rows.sort((left, right) =>
      left.start.localeCompare(right.start),
    );
    snapshot.sourceRevision = activities.revision;
    snapshot.summaries = summaries.rows.sort((left, right) =>
      left.generatedAt.localeCompare(right.generatedAt),
    );
    if (activities.issue)
      snapshot.issues.push(`活动读取失败：${activities.issue}`);
    if (summaries.issue)
      snapshot.issues.push(`总结读取失败：${summaries.issue}`);
  } catch (error) {
    snapshot.issues.push(`配置读取失败：${configPath}：${errorMessage(error)}`);
  }
  return SnapshotSchema.parse(snapshot);
}

/** 只接受当前快照内的活动 ID，图片引用按 scening 的路径语义解析。 */
export async function readSnapshotImage(
  snapshot: Snapshot,
  id: string,
  frameIndex?: number,
): Promise<ImageResult> {
  const activity = snapshot.activities.find((item) => item.id === id);
  if (snapshot.source !== 'local' || !activity)
    return { status: 'missing', message: '请重新选择当前日期的活动。' };
  try {
    const frame =
      frameIndex === undefined ? null : activity.frames?.[frameIndex - 1];
    if (frameIndex !== undefined && !frame)
      return { status: 'missing', message: '所选原图不在这条记录中。' };
    const reference = frame ? frame.screenshot : activity.screenshot;
    if (!reference.trim() || reference.split(/[\\/]/).includes('..'))
      throw new Error('截图引用应在允许的目录内');
    const absolute = path.isAbsolute(reference);
    const target = await realpath(
      absolute ? reference : path.resolve(snapshot.locations.home, reference),
    );
    if (!absolute) {
      const base = await realpath(snapshot.locations.home);
      const relative = path.relative(base, target);
      if (
        relative.startsWith(`..${path.sep}`) ||
        relative === '..' ||
        path.isAbsolute(relative)
      )
        throw new Error('相对截图引用超出记录目录');
    }
    const bytes = await readFile(target);
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'image/jpeg'
        : null;
    if (!mime) throw new Error('截图格式应为 PNG 或 JPEG');
    return {
      status: 'ready',
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    };
  } catch (error) {
    return {
      status: 'missing',
      message: `截图暂时无法读取：${errorMessage(error)}`,
    };
  }
}
