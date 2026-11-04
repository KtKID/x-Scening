import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BackfillStatusSchema } from '../shared/scening.generated';
import { withReason } from './diagnostics';
import { BackfillActionSchema, BackfillQuerySchema } from '../shared/protocol';
import type {
  BackfillAction,
  BackfillQuery,
  BackfillStatus,
} from '../shared/protocol';

const execute = promisify(execFile);
/** 桌面只管理自有补跑进程；报告提交、锁和恢复继续由Python负责。 */
export class BackfillService {
  private readonly configPath: string;
  private job: {
    day: string;
    child: ChildProcess;
    done: Promise<void>;
    stopping: boolean;
  } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private commands = 0;
  private closing = false;
  private outcomes = new Map<string, 'failed' | 'cancelled'>();
  private reads = new Map<string, Promise<BackfillStatus>>();

  constructor(
    root: string,
    configPath?: string,
    private readonly runtimeRoot = root,
  ) {
    this.configPath = path.resolve(
      configPath ?? path.join(root, 'observer.yaml'),
    );
  }
  private get python(): string {
    return path.join(this.runtimeRoot, '.venv/bin/python');
  }
  private get options() {
    return {
      cwd: this.runtimeRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(this.runtimeRoot, 'src'),
        PATH: [
          process.env.PATH ?? '',
          path.join(homedir(), '.local/bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ].join(path.delimiter),
      },
    };
  }
  private args(module: string, day: string): string[] {
    return ['-B', '-m', module, '--config', this.configPath, '--day', day];
  }
  get hasWork(): boolean {
    return this.job !== null || this.commands > 0;
  }
  /** 当前补跑作业的只读快照；排队中的控制命令不算运行。 */
  background(): { running: boolean; activeDay: string | null } {
    return this.job
      ? { running: true, activeDay: this.job.day }
      : { running: false, activeDay: null };
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.job) {
      this.job.stopping = true;
      this.job.child.kill('SIGTERM');
    }
    await this.queue;
    await this.job?.done;
  }
  async read(raw: BackfillQuery): Promise<BackfillStatus> {
    const { day } = BackfillQuerySchema.parse(raw);
    let pending = this.reads.get(day);
    if (!pending) {
      pending = this.scan(day).finally(() => this.reads.delete(day));
      this.reads.set(day, pending);
    }
    const result = await pending;
    if (this.job) {
      const owned = this.job.day === day;
      return {
        ...result,
        activeDay: this.job.day,
        owned,
        ...(owned
          ? {
              state: 'running',
              message: this.job.stopping
                ? '正在停止补分析，等待当前工作收尾。'
                : '正在补分析，成功结果会自动保存。',
            }
          : {}),
      };
    }
    const outcome = this.outcomes.get(day);
    if (
      outcome &&
      result.state !== 'running' &&
      result.state !== 'completed' &&
      result.state !== 'empty' &&
      result.state !== 'error' &&
      result.state !== 'partial'
    )
      return {
        ...result,
        state: outcome,
        message:
          outcome === 'cancelled'
            ? '补分析已停止，已保存结果保留。'
            : '补分析进程中断，请检查模型配置后继续。',
      };
    return result;
  }
  private async scan(day: string): Promise<BackfillStatus> {
    try {
      const result = await execute(
        this.python,
        this.args('scening.screenshot_backfill_status', day),
        this.options,
      );
      const raw: unknown = JSON.parse(result.stdout);
      const reply = BackfillStatusSchema.parse(raw);
      if (reply.day !== day) throw new Error('补分析日期不匹配');
      return reply;
    } catch (error: unknown) {
      return {
        day,
        state: 'error',
        total: null,
        analyzed: null,
        remaining: null,
        eligible: false,
        planned: 0,
        processed: 0,
        activeDay: null,
        owned: false,
        message: withReason(
          '核对失败，请检查项目Python环境、配置与当天报告后重试',
          error,
        ),
      };
    }
  }
  control(raw: BackfillAction): Promise<BackfillStatus> {
    const request = BackfillActionSchema.parse(raw);
    this.commands++;
    const operation = this.queue.then(() => this.apply(request));
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation.finally(() => this.commands--);
  }
  private async apply(request: BackfillAction): Promise<BackfillStatus> {
    if (request.action === 'stop') {
      if (this.job?.day === request.day) {
        this.job.stopping = true;
        this.job.child.kill('SIGTERM');
        await this.job.done;
      }
    } else if (!this.job && !this.closing) {
      const status = await this.read({ day: request.day });
      if (
        !this.closing &&
        status.eligible &&
        status.remaining !== null &&
        status.remaining > 0 &&
        status.state !== 'running' &&
        status.state !== 'error'
      ) {
        this.outcomes.delete(request.day);
        const child = spawn(
          this.python,
          [
            ...this.args('scening.screenshot_backfill', request.day),
            '--execute',
          ],
          { ...this.options, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        // 运行明细由Python独立保存；持续消费输出，防止管道积压阻塞工作进程。
        child.stdout?.resume();
        child.stderr?.resume();
        const done = new Promise<void>((resolve) => {
          child.on('error', () => this.outcomes.set(request.day, 'failed'));
          child.on('close', (code) => {
            if (this.job?.child === child) {
              if (this.job.stopping)
                this.outcomes.set(request.day, 'cancelled');
              else if (code !== 0) this.outcomes.set(request.day, 'failed');
              this.job = null;
            }
            resolve();
          });
        });
        this.job = { day: request.day, child, done, stopping: false };
      }
    }
    return this.read({ day: request.day });
  }
}
