import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { createWriteStream, constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  ObserverConfigSchema,
  DesktopConfigSchema,
  ControlConfigSchema,
} from '../shared/scening.generated';
import { runtimeControl } from './runtime-control';
import { resolveConfiguredPath } from './config-paths';
import type {
  CaptureMode,
  CaptureState,
  RuntimeSnapshot,
} from '../shared/protocol';

const execute = promisify(execFile);
const SettingsSchema = z.object({
  home: ObserverConfigSchema.shape.home,
  desktop: DesktopConfigSchema.optional(),
  control: ControlConfigSchema.optional(),
});
const ProcessIdSchema = z.coerce.number().int().positive();
const FailureCodeSchema = z.object({ code: z.union([z.string(), z.number()]) });
const PROGRESS_PREVIEW_LENGTH = 400;

/** 保留终端事件的进度信息，移除专用于排查的文件位置。 */
function captureProgressText(line: string): string {
  return line
    .replace(/(候选 JPEG 已保存)：.*?(?=；原分辨率 |$)/u, '$1')
    .replace(/(KMH 分析中|KMH 分析完成，记录已保存|总结已保存)：.*$/u, '$1')
    .replace(/；home=.*$/u, '')
    .replace(/(['"])(?:~|\.{0,2})\/.*?\1/gu, '')
    .replace(/(?:^|(?<=[\s：=（(]))(?:~|\.{0,2})\/[^\s；，]+/gu, '')
    .trim();
}

type Identity = { pid: number; birth: string; mode: CaptureMode };
type Managed = {
  child: ChildProcess;
  pid: number;
  closed: Promise<void>;
  interval: number;
  mode: CaptureMode;
  home: string;
  control: z.infer<typeof ControlConfigSchema>;
};

/** 主进程独占控制能力；Python继续持有home锁和全部正式文件的写入职责。 */
export class CaptureController {
  private state: CaptureState = { state: 'stopped', message: '采集已停止' };
  private managed: Managed | null = null;
  // 独立采集沿用已观察到的启动位置，配置保存后仍可控制当前进程。
  private observedSettings: Pick<
    Managed,
    'home' | 'interval' | 'control'
  > | null = null;
  private stopping: Identity | null = null;
  private operation: Promise<void> = Promise.resolve();
  private readonly configPath: string;
  private analysisPreference = true;
  private changingMode = false;
  private stopRequested = false;
  private launchTask: Promise<RuntimeSnapshot> | null = null;
  private listeners = new Set<(runtime: RuntimeSnapshot) => void>();
  private interval = 0;
  private revision = 0;
  constructor(
    private readonly root: string,
    configPath?: string,
    private readonly cacheRoot?: string,
  ) {
    this.configPath = path.resolve(
      configPath ?? path.join(root, 'observer.yaml'),
    );
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(run);
    this.operation = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  subscribe(listener: (runtime: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(): void {
    if (this.interval > 0)
      for (const listener of this.listeners)
        listener(this.runtime(this.interval));
  }
  private managedRuntime(): RuntimeSnapshot | null {
    const owned = this.managed;
    return owned ? this.runtime(owned.interval) : null;
  }
  private async settings() {
    const document = parseDocument(await readFile(this.configPath, 'utf8'), {
      uniqueKeys: true,
    });
    if (document.errors.length)
      throw new Error(document.errors.map((error) => error.message).join('；'));
    const raw: unknown = document.toJS();
    const settings = SettingsSchema.parse(raw);
    if (!settings.home.trim()) throw new Error('home应有内容');
    let desktop = settings.desktop;
    let control = settings.control;
    if (!desktop || !control) {
      const defaults = parseDocument(
        await readFile(path.join(this.root, 'observer.yaml'), 'utf8'),
        { uniqueKeys: true },
      );
      if (defaults.errors.length) throw new Error('项目默认配置读取失败');
      const defaultRaw: unknown = defaults.toJS();
      const defaultSettings = SettingsSchema.parse(defaultRaw);
      desktop ??= defaultSettings.desktop;
      control ??= defaultSettings.control;
      if (!desktop)
        throw new Error(
          '请在项目observer.yaml配置desktop.refreshIntervalSeconds',
        );
    }
    if (!control) throw new Error('项目observer.yaml缺少control配置');
    this.interval = desktop.refreshIntervalSeconds;
    return {
      home: resolveConfiguredPath(this.configPath, settings.home),
      interval: desktop.refreshIntervalSeconds,
      control,
    };
  }
  /** 锁路径、项目工作目录、模块入口和进程启动时间共同确定外部采集身份。 */
  private async external(home: string): Promise<Identity | null> {
    try {
      await access(path.join(home, 'observer.lock'));
    } catch {
      return null;
    }
    let output: string;
    try {
      output = (
        await execute('/usr/sbin/lsof', [
          '-t',
          '--',
          path.join(home, 'observer.lock'),
        ])
      ).stdout;
    } catch (error) {
      if (FailureCodeSchema.safeParse(error).data?.code === 1) return null;
      throw error;
    }
    for (const raw of new Set(output.trim().split(/\s+/))) {
      const parsed = ProcessIdSchema.safeParse(raw);
      if (!parsed.success) continue;
      const pid = parsed.data;
      try {
        const [command, cwd, birth] = await Promise.all([
          execute('/bin/ps', ['-p', String(pid), '-o', 'command=']),
          execute('/usr/sbin/lsof', [
            '-a',
            '-p',
            String(pid),
            '-d',
            'cwd',
            '-Fn',
          ]),
          execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=']),
        ]);
        if (
          !/(?:^|\s)-m\s+scening\.observe_activity(?:\s|$)/.test(command.stdout)
        )
          continue;
        if (
          !cwd.stdout.split('\n').includes(`n${this.root}`) ||
          !birth.stdout.trim()
        )
          continue;
        return {
          pid,
          birth: birth.stdout.trim(),
          mode: /(?:^|\s)--capture-only(?:\s|$)/.test(command.stdout)
            ? 'capture-only'
            : 'full',
        };
      } catch {
        /* 进程在查询期间退出，按下一个持有者继续核对。 */
      }
    }
    // 其他程序持有文件时，由Python的同home锁继续仲裁启动。
    return null;
  }
  private async snapshot(): Promise<RuntimeSnapshot> {
    const initialOwned = this.managedRuntime();
    if (initialOwned) return initialOwned;
    const settings = this.observedSettings ?? (await this.settings());
    const configuredOwned = this.managedRuntime();
    if (configuredOwned) return configuredOwned;
    if (process.platform !== 'darwin')
      return {
        capture: {
          state: 'unsupported',
          message: '现有scening采集适用于macOS；本平台可浏览已保存记录',
        },
        analysisEnabled: this.analysisPreference,
        refreshIntervalSeconds: settings.interval,
        revision: ++this.revision,
      };
    if (!this.managed) {
      const external = await this.external(settings.home);
      const detectedOwned = this.managedRuntime();
      if (detectedOwned) return detectedOwned;
      if (external) {
        this.observedSettings = settings;
        let externalStopping = false;
        try {
          const reply = await runtimeControl(
            settings.home,
            external.pid,
            'status',
            settings.control.timeoutSeconds,
          );
          const respondingOwned = this.managedRuntime();
          if (respondingOwned) return respondingOwned;
          external.mode = reply.analysisEnabled ? 'full' : 'capture-only';
          if (reply.state === 'stopped') {
            this.observedSettings = null;
            this.state = {
              state: 'stopped',
              message: '采集已停止，当前任务已回收',
            };
            return this.runtime(settings.interval);
          }
          externalStopping = reply.state === 'stopping';
        } catch {
          /* 旧版本仍可按原进程身份查看与显式停止。 */
        }
        const finalOwned = this.managedRuntime();
        if (finalOwned) return finalOwned;
        this.state = {
          state:
            externalStopping ||
            (this.stopping?.pid === external.pid &&
              this.stopping.birth === external.birth)
              ? 'stopping'
              : 'running',
          pid: external.pid,
          origin: 'external',
          mode: external.mode,
          message:
            external.mode === 'capture-only'
              ? '独立进程正在仅截图，活动分析按完整模式启动后提供'
              : '独立进程正在运行截图、分析与活动记录',
        };
      } else {
        this.observedSettings = null;
        if (
          this.state.state === 'running' ||
          this.state.state === 'stopping' ||
          this.state.state === 'starting'
        ) {
          this.state = { state: 'stopped', message: '采集进程已退出' };
          this.stopping = null;
        }
      }
    }
    return this.runtime(settings.interval);
  }
  private runtime(interval: number): RuntimeSnapshot {
    return {
      capture: this.state,
      analysisEnabled:
        'pid' in this.state
          ? this.state.mode === 'full'
          : this.analysisPreference,
      refreshIntervalSeconds: interval,
      revision: ++this.revision,
    };
  }
  read(): Promise<RuntimeSnapshot> {
    return this.snapshot();
  }
  start(): Promise<RuntimeSnapshot> {
    this.stopRequested = false;
    const task = this.serialize(() => this.launch());
    this.launchTask = task;
    return task.finally(() => {
      if (this.launchTask === task) this.launchTask = null;
    });
  }
  private async launch(): Promise<RuntimeSnapshot> {
    const current = await this.snapshot();
    if (
      this.stopRequested ||
      'pid' in current.capture ||
      current.capture.state === 'unsupported'
    )
      return current;
    const settings = await this.settings();
    try {
      const mode: CaptureMode = this.analysisPreference
        ? 'full'
        : 'capture-only';
      const python = path.join(this.root, '.venv/bin/python');
      await access(python, constants.X_OK);
      const cache = this.cacheRoot ?? path.join(this.root, 'desktop/.cache');
      await mkdir(path.join(cache, 'tmp'), { recursive: true });
      const output = createWriteStream(path.join(cache, 'capture.log'), {
        flags: 'a',
      });
      output.on('error', (error) => {
        if ('pid' in this.state)
          this.state = {
            ...this.state,
            message: `采集输出日志写入失败：${captureProgressText(error.message)}`,
          };
      });
      const child = spawn(
        python,
        [
          '-u',
          '-B',
          '-m',
          'scening.observe_activity',
          '--config',
          this.configPath,
          ...(mode === 'capture-only' ? ['--capture-only'] : []),
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
            ]
              .filter(Boolean)
              .join(path.delimiter),
            TMPDIR: path.join(cache, 'tmp'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const pid = child.pid;
      if (!pid) throw new Error('采集进程启动失败');
      this.state = {
        state: 'starting',
        pid,
        origin: 'client',
        mode,
        message:
          mode === 'full'
            ? '正在初始化截图、分析与活动记录'
            : '正在初始化仅截图模式',
      };
      let lastLine = '';
      let lastIssue = '';
      for (const input of [child.stdout, child.stderr]) {
        if (!input) continue;
        input.pipe(output, { end: false });
        createInterface({ input }).on('line', (line) => {
          if (/^\[[^\]]+\] (?:screenshot|mini) 目标路径：/u.test(line)) return;
          const preview = captureProgressText(line);
          if (!preview) return;
          lastLine = preview.slice(-PROGRESS_PREVIEW_LENGTH);
          if (/失败|Error|Traceback/.test(line) && !line.includes('观察已停止'))
            lastIssue = lastLine;
          if ('pid' in this.state && this.state.pid === pid)
            this.state = {
              ...this.state,
              state: this.state.state === 'stopping' ? 'stopping' : 'running',
              message: lastLine,
            };
          this.publish();
        });
      }
      const closed = new Promise<void>((resolve) => {
        child.once('close', (code, signal) => {
          output.end();
          this.managed = null;
          const requestedEarlyStop =
            signal === 'SIGTERM' && this.state.state === 'stopping';
          this.state =
            code === 0 || requestedEarlyStop
              ? {
                  state: 'stopped',
                  message: '采集已停止，当前记录保存流程已完成',
                }
              : {
                  state: 'error',
                  message: `采集退出（${signal ?? String(code)}）：${lastIssue || lastLine || '请查看采集日志'}`,
                };
          resolve();
          this.publish();
        });
      });
      this.managed = {
        child,
        pid,
        closed,
        interval: current.refreshIntervalSeconds,
        mode,
        home: settings.home,
        control: settings.control,
      };
      if (this.stopRequested) {
        this.state = { ...this.state, state: 'stopping' };
        child.kill('SIGTERM');
      }
      this.publish();
    } catch (error) {
      this.state = {
        state: 'error',
        message:
          error instanceof Error
            ? captureProgressText(error.message)
            : '采集启动失败',
      };
    }
    return this.snapshot();
  }
  stop(): Promise<RuntimeSnapshot> {
    this.stopRequested = true;
    return this.requestStop();
  }
  private async requestStop(): Promise<RuntimeSnapshot> {
    const began = performance.now();
    // 启动窗口可独立等待当前launch；分析切换占用的操作队列保持可绕过。
    if (this.launchTask) await this.launchTask;
    const owned = this.managed;
    const current = owned
      ? {
          ...this.runtime(owned.interval),
          capture: {
            state: 'running',
            pid: owned.pid,
            origin: 'client',
            mode: owned.mode,
            message: '正在请求停止',
          } satisfies CaptureState,
        }
      : await this.snapshot();
    if (!('pid' in current.capture)) return current;
    const pid = current.capture.pid;
    const settings = owned
      ? { home: owned.home, interval: owned.interval, control: owned.control }
      : (this.observedSettings ?? (await this.settings()));
    const remaining = (): number =>
      Math.max(
        0,
        settings.control.timeoutSeconds - (performance.now() - began) / 1000,
      );
    this.state = {
      ...current.capture,
      state: 'stopping',
      message: '正在停止截屏并取消当前分析',
    };
    this.publish();
    try {
      try {
        await runtimeControl(settings.home, pid, 'stop', remaining());
      } catch (error) {
        if (owned && owned.child.exitCode === 0) {
          await owned.closed;
          return this.runtime(settings.interval);
        }
        const code = FailureCodeSchema.safeParse(error).data?.code;
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
        if (owned) owned.child.kill('SIGTERM');
        else {
          const identity = await this.external(settings.home);
          const checked = await this.external(settings.home);
          if (
            !identity ||
            !checked ||
            checked.pid !== pid ||
            identity.birth !== checked.birth
          )
            throw new Error('采集进程身份已变化，请刷新');
          process.kill(pid, 'SIGTERM');
          this.stopping = identity;
        }
      }
      if (owned) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            owned.closed,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('采集退出等待超时，请查看logs')),
                remaining() * 1000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        // 完成回执在Python释放采集资源后返回，快照立即反映真实停止。
        this.state = {
          state: 'stopped',
          message: '采集已停止，当前任务已回收',
        };
        this.stopping = null;
      }
    } catch (error) {
      if ('pid' in this.state && this.state.pid === pid)
        this.state = {
          ...this.state,
          message:
            error instanceof Error
              ? captureProgressText(error.message)
              : '停止失败，请重试',
        };
      this.publish();
      throw error;
    }
    this.publish();
    return this.runtime(settings.interval);
  }
  /** 开关在现有Python进程内生效；停止可绕过此队列并覆盖迟到回执。 */
  setAnalysisEnabled(enabled: boolean): Promise<RuntimeSnapshot> {
    return this.serialize(async () => {
      const began = performance.now();
      if (this.stopRequested) return this.read();
      this.changingMode = true;
      try {
        const current = await this.snapshot();
        if (current.capture.state === 'unsupported') return current;
        this.analysisPreference = enabled;
        if (!('pid' in current.capture))
          return this.runtime(current.refreshIntervalSeconds);
        const pid = current.capture.pid;
        const mode: CaptureMode = enabled ? 'full' : 'capture-only';
        if (current.capture.mode === mode) return current;
        const owned = this.managed;
        const settings = owned
          ? { home: owned.home, control: owned.control }
          : (this.observedSettings ?? (await this.settings()));
        const reply = await runtimeControl(
          settings.home,
          pid,
          enabled ? 'enable-analysis' : 'disable-analysis',
          Math.max(
            0,
            settings.control.timeoutSeconds -
              (performance.now() - began) / 1000,
          ),
        ).catch((error: unknown) => {
          if (this.stopRequested) return null;
          throw error;
        });
        if (!reply) return this.runtime(current.refreshIntervalSeconds);
        if (
          this.stopRequested ||
          !('pid' in this.state) ||
          this.state.pid !== pid
        )
          return this.runtime(current.refreshIntervalSeconds);
        this.state = {
          ...current.capture,
          state: reply.state === 'running' ? 'running' : 'stopping',
          mode: reply.analysisEnabled ? 'full' : 'capture-only',
          message: reply.analysisEnabled
            ? '分析已开启，采集持续运行'
            : '分析已关闭，继续保存截图',
        };
        if (owned) owned.mode = this.state.mode;
        this.publish();
        return this.runtime(current.refreshIntervalSeconds);
      } finally {
        this.changingMode = false;
      }
    });
  }
  /** 应用退出只回收自有Python；显式停止仍可控制核对身份后的外部进程。 */
  async shutdown(): Promise<void> {
    this.stopRequested = true;
    if (this.launchTask) await this.launchTask;
    if (this.managed) await this.requestStop();
    await this.operation;
  }
  get ownsProcess(): boolean {
    return this.managed !== null || this.changingMode;
  }
}
