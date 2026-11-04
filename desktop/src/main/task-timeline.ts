import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { resolveConfiguredPath } from './config-paths';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  TaskTimelineConfigSchema,
  TimelineReadReplySchema,
} from '../shared/scening.generated';
import { TaskTimelineQuerySchema } from '../shared/protocol';
import type { TaskTimelineQuery, RuntimeSnapshot } from '../shared/protocol';
import { withReason } from './diagnostics';

type Reply = z.infer<typeof TimelineReadReplySchema>;
const LocationSchema = z
  .object({
    home: z.string().min(1),
    taskTimeline: TaskTimelineConfigSchema.nullish(),
  })
  .passthrough();
/** 按需运行短投影和单个整理作业；取消沿Python信号回收模型整组。 */
export class TaskTimelineService {
  private child: ChildProcess | null = null;
  private organizingDay: string | null = null;
  private inflight: Promise<Reply> | null = null;
  private failures = new Map<string, string>();
  private cached: { key: string; reply: Reply } | null = null;
  private allowed = true;
  private initialized = false;
  private previousRunning = false;
  private previousAnalysis = true;
  private epoch = 0;
  private lastStarted = 0;
  private attempts = new Map<string, { count: number; at: number }>();
  private configPath: string;
  constructor(
    root: string,
    configPath?: string,
    private readonly runtimeRoot = root,
  ) {
    this.configPath = path.resolve(
      configPath ?? path.join(root, 'observer.yaml'),
    );
  }
  runtime(state: RuntimeSnapshot): void {
    const running = state.capture.state === 'running';
    if (!this.initialized) {
      this.allowed = state.analysisEnabled;
      this.initialized = true;
    }
    if (!state.analysisEnabled || (this.previousRunning && !running))
      this.suspend();
    if (
      state.analysisEnabled &&
      (!this.previousAnalysis || (running && !this.previousRunning))
    )
      this.permit();
    this.previousAnalysis = state.analysisEnabled;
    this.previousRunning = running;
  }
  get hasWork(): boolean {
    return this.child !== null;
  }
  /** 当前整理作业的只读快照；running 与子进程存续一致。 */
  background(): { running: boolean; day: string | null } {
    return { running: this.child !== null, day: this.organizingDay };
  }
  async shutdown(): Promise<void> {
    this.suspend();
    await this.inflight?.catch(() => {});
  }
  permit(): void {
    this.allowed = true;
  }
  suspend(): void {
    this.allowed = false;
    this.epoch++;
    this.child?.kill('SIGTERM');
  }
  private call(action: 'project' | 'organize', day: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const process = execFile(
        path.join(this.runtimeRoot, '.venv/bin/python'),
        [
          '-B',
          '-m',
          'scening.task_timeline',
          action,
          '--config',
          this.configPath,
          '--day',
          day,
        ],
        {
          cwd: this.runtimeRoot,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...globalThis.process.env,
            PYTHONPATH: path.join(this.runtimeRoot, 'src'),
            PATH: [
              globalThis.process.env.PATH ?? '',
              path.join(homedir(), '.local/bin'),
              '/opt/homebrew/bin',
              '/usr/local/bin',
            ].join(path.delimiter),
          },
        },
        (error, stdout) => {
          if (action === 'organize' && this.child === process) {
            this.child = null;
            this.organizingDay = null;
          }
          if (error) {
            reject(
              new Error(
                withReason('任务整理进程结束，原活动可继续查看', error),
              ),
            );
            return;
          }
          try {
            const raw: unknown = JSON.parse(stdout);
            resolve(TimelineReadReplySchema.parse(raw));
          } catch (parseError: unknown) {
            reject(
              new Error(withReason('任务整理回复暂时无法读取', parseError)),
            );
          }
        },
      );
      if (action === 'organize') this.child = process;
    });
  }
  async read(raw: TaskTimelineQuery): Promise<Reply> {
    const query = TaskTimelineQuerySchema.parse(raw);
    const empty: Reply = {
      semanticRevision: '',
      needsOrganization: false,
      pendingCount: 0,
      day: query.day,
      sourceRevision: '',
      taskRevision: '',
      evidenceRevision: '',
      organizing: 'disabled',
      coveredUntil: null,
      view: null,
      issues: [],
    };
    if (query.source === 'demo') return empty;
    try {
      const value: unknown = parse(await readFile(this.configPath, 'utf8'));
      const configured = LocationSchema.parse(value);
      const defaults: unknown = parse(
        await readFile(path.join(this.runtimeRoot, 'observer.yaml'), 'utf8'),
      );
      const policy =
        configured.taskTimeline ?? LocationSchema.parse(defaults).taskTimeline;
      if (!policy) throw new Error('缺少任务整理参数');
      const home = await realpath(
        resolveConfiguredPath(this.configPath, configured.home),
      );
      const revisions = await Promise.all(
        ['records', 'task-timeline', 'activity-evidence'].map(
          async (folder) => {
            try {
              return createHash('sha256')
                .update(
                  await readFile(path.join(home, folder, `${query.day}.json`)),
                )
                .digest('hex');
            } catch (error) {
              if (
                z.object({ code: z.literal('ENOENT') }).safeParse(error).success
              )
                return '';
              throw error;
            }
          },
        ),
      );
      const cacheKey = JSON.stringify([home, query.day, policy, revisions]);
      const result =
        this.cached?.key === cacheKey
          ? this.cached.reply
          : await this.call('project', query.day);
      if (
        result.sourceRevision === revisions[0] &&
        result.taskRevision === revisions[1] &&
        result.evidenceRevision === revisions[2]
      )
        this.cached = { key: cacheKey, reply: result };
      if (
        query.expectedSourceRevision &&
        result.sourceRevision !== query.expectedSourceRevision
      )
        return { ...empty, issues: ['活动已更新，正在等待下一次刷新。'] };
      const key = `${home}:${query.day}:${result.semanticRevision}:${result.taskRevision}`;
      const failureKey = JSON.stringify([home, query.day]);
      if (query.refreshReason === 'manual') this.attempts.delete(key);
      const previous = this.attempts.get(key);
      const interval = previous
        ? policy.retryIntervalSeconds
        : policy.minOrganizeIntervalSeconds;
      const due = !previous || Date.now() - previous.at >= interval * 1000;
      if (
        result.needsOrganization &&
        this.allowed &&
        !this.child &&
        due &&
        (this.lastStarted === 0 ||
          Date.now() - this.lastStarted >=
            policy.minOrganizeIntervalSeconds * 1000) &&
        (previous?.count ?? 0) < policy.maxAttemptsPerRevision &&
        result.view?.segments.length
      ) {
        const epoch = this.epoch;
        this.lastStarted = Date.now();
        this.attempts.set(key, {
          count: (previous?.count ?? 0) + 1,
          at: Date.now(),
        });
        this.organizingDay = query.day;
        this.inflight = this.call('organize', query.day);
        this.inflight
          .then((reply) => {
            if (epoch !== this.epoch) return;
            if (reply.organizing !== 'failed') {
              this.attempts.delete(key);
              this.failures.delete(failureKey);
            } else
              this.failures.set(
                failureKey,
                reply.issues[0] ??
                  '任务整理失败，已保留上次结果；可用刷新重试。',
              );
          })
          .catch(() => {
            if (epoch !== this.epoch) return;
            this.failures.set(
              failureKey,
              '任务整理进程已结束，已有结果可继续查看。',
            );
          });
      }
      const failure = this.failures.get(failureKey);
      return {
        ...result,
        issues: failure ? [...result.issues, failure] : result.issues,
        organizing: !this.allowed
          ? 'disabled'
          : this.child
            ? 'running'
            : result.organizing,
      };
    } catch {
      return {
        ...empty,
        organizing: 'failed',
        issues: ['任务关联暂时不可用，原活动可继续查看。'],
      };
    }
  }
}
