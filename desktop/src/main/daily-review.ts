import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import {
  DailyReviewReplySchema,
  DailyReviewErrorSchema,
  DailyReviewViewSchema,
  DailyReviewCandidatesSchema,
} from '../shared/scening.generated';
import { DailyReviewQuerySchema, DaySchema } from '../shared/protocol';
import type { DailyReviewQuery, DailyReviewReply } from '../shared/protocol';
import { demoDailyReview } from '../shared/demo';

export type DailyView = z.infer<typeof DailyReviewViewSchema>;
/** 每日专属进程桥接：读取和生成分离，错误完整传递，自有进程可有序取消。 */
export class DailyReviewService {
  private pending = new Map<string, Promise<DailyReviewReply>>();
  private generation = new Map<string, Promise<DailyView>>();
  private children = new Set<ChildProcess>();
  private jobs = new Set<Promise<unknown>>();
  private closing = false;
  private epoch = 0;
  private readonly configPath: string;
  constructor(
    private readonly root: string,
    configPath?: string,
  ) {
    this.configPath = path.resolve(
      configPath ?? path.join(root, 'observer.yaml'),
    );
  }
  settingsChanged(): void {
    this.epoch++;
  }
  get hasWork(): boolean {
    return this.children.size > 0;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const child of this.children) child.kill('SIGTERM');
    await Promise.allSettled([...this.jobs]);
  }
  private call<T>(
    args: string[],
    schema: z.ZodType<T>,
    allowErrorReply = false,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error('每日总结正在退出'));
    const operation = new Promise<T>((resolve, reject) => {
      const child = spawn(
        path.join(
          this.root,
          process.platform === 'win32'
            ? '.venv/Scripts/python.exe'
            : '.venv/bin/python',
        ),
        [
          '-B',
          '-m',
          'scening.daily_review',
          '--config',
          this.configPath,
          ...args,
        ],
        {
          cwd: this.root,
          env: {
            ...process.env,
            PYTHONPATH: path.join(this.root, 'src'),
            PATH: [
              process.env.PATH ?? '',
              path.join(homedir(), '.local/bin'),
              '/opt/homebrew/bin',
              '/usr/local/bin',
            ].join(path.delimiter),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      this.children.add(child);
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => {
        output.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors.push(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        this.children.delete(child);
        const stdout = Buffer.concat(output).toString('utf8');
        const stderr = Buffer.concat(errors).toString('utf8');
        if (code !== 0) {
          reject(new Error(stderr || `每日总结进程退出：${String(code)}`));
          return;
        }
        try {
          const raw: unknown = JSON.parse(stdout);
          const fault = DailyReviewErrorSchema.safeParse(raw);
          if (fault.success && !allowErrorReply) {
            reject(new Error(fault.data.message));
            return;
          }
          resolve(schema.parse(raw));
        } catch (error: unknown) {
          reject(
            new Error(
              `${error instanceof Error ? error.message : String(error)}\n${stderr}\n${stdout}`,
            ),
          );
        }
      });
    });
    const task = operation.finally(() => {
      this.jobs.delete(task);
    });
    this.jobs.add(task);
    return task;
  }
  read(raw: DailyReviewQuery): Promise<DailyReviewReply> {
    const query = DailyReviewQuerySchema.parse(raw);
    if (query.source === 'demo')
      return Promise.resolve(
        DailyReviewReplySchema.parse(demoDailyReview(query.day)),
      );
    const key = `${this.epoch}:${query.day}:${query.cachedOnly}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const args = ['--day', query.day];
    if (query.refresh) args.push('--refresh');
    if (query.cachedOnly) args.push('--cached-only');
    const task = this.call(args, DailyReviewReplySchema, true)
      .catch((error: unknown): DailyReviewReply => ({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
  }
  inspect(day: string): Promise<DailyView> {
    return this.call(
      ['--action', 'inspect', '--day', DaySchema.parse(day)],
      DailyReviewViewSchema,
    );
  }
  candidates(): Promise<z.infer<typeof DailyReviewCandidatesSchema>> {
    return this.call(['--action', 'candidates'], DailyReviewCandidatesSchema);
  }
  generate(
    day: string,
    trigger: 'automatic' | 'manual',
    homeId: string,
  ): Promise<DailyView> {
    day = DaySchema.parse(day);
    const key = `${homeId}:${day}`;
    const pending = this.generation.get(key);
    if (pending) return pending;
    const task = this.call(
      [
        '--action',
        'generate',
        '--day',
        day,
        '--trigger',
        trigger,
        '--expected-home-id',
        homeId,
      ],
      DailyReviewViewSchema,
    ).finally(() => {
      this.generation.delete(key);
    });
    this.generation.set(key, task);
    return task;
  }
  presented(day: string, revision: string, homeId: string): Promise<DailyView> {
    return this.call(
      [
        '--action',
        'presented',
        '--day',
        DaySchema.parse(day),
        '--revision',
        revision,
        '--expected-home-id',
        homeId,
      ],
      DailyReviewViewSchema,
    );
  }
}
