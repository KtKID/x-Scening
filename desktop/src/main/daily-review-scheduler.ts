import type { DailyReviewService, DailyView } from './daily-review';
import { localDay, moveDay } from '../shared/protocol';

type DailyPort = Pick<
  DailyReviewService,
  'candidates' | 'inspect' | 'generate'
>;
type Events = {
  changed: (view: DailyView) => void;
  open: (view: DailyView) => void;
  problem: (error: unknown) => void;
};
/** 独立每日调度；每次只推进一个日期，原分析服务保持独立。 */
export class DailyReviewScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private checking = false;
  private recheck = false;
  private sent = new Set<string>();
  constructor(
    private readonly service: DailyPort,
    private readonly events: Events,
    private readonly isFront: () => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}
  start(): void {
    this.active = true;
    this.check().catch(this.events.problem);
  }
  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
  }
  policyChanged(): void {
    if (this.timer) clearTimeout(this.timer);
    this.recheck = true;
    this.check().catch(this.events.problem);
  }
  resetPresentation(): void {
    this.sent.clear();
  }
  async foreground(): Promise<void> {
    if (!this.isFront()) return;
    const today = localDay(this.now());
    const view = await this.service.inspect(moveDay(today, -1));
    // 查询期间的失焦、隐藏和锁屏保留下一次前台展示机会。
    if (!this.isFront() || localDay(this.now()) !== today) return;
    if (
      view.presentedOn === today ||
      this.now().getTime() < new Date(view.dueAt).getTime()
    )
      return;
    if (
      !view.report &&
      !view.canSummarize &&
      !['running', 'waiting_retry', 'failed'].includes(view.phase)
    )
      return;
    const key = `${view.homeId}:${today}:${view.report?.generationId ?? view.report?.sourceHash ?? 'pending'}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    this.events.open(view);
  }
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.recheck = false;
    let delay: number | undefined;
    try {
      const candidates = await this.service.candidates();
      const now = this.now();
      const [hours, minutes] = candidates.policy.scheduledTime
        .split(':')
        .map(Number);
      const due = new Date(now);
      due.setHours(hours ?? 0, minutes ?? 0, 0, 0);
      if (due <= now) due.setDate(due.getDate() + 1);
      delay = Math.min(
        candidates.policy.checkIntervalSeconds * 1000,
        due.getTime() - now.getTime(),
      );
      if (candidates.nextCheckAt)
        delay = Math.min(
          delay,
          Math.max(
            0,
            new Date(candidates.nextCheckAt).getTime() - now.getTime(),
          ),
        );
      await this.foreground();
      const day = candidates.days[0];
      if (day) {
        const result = await this.service.generate(
          day,
          'automatic',
          candidates.homeId,
        );
        this.events.changed(result);
        if (result.nextAttemptAt)
          delay = Math.min(
            delay,
            Math.max(
              0,
              new Date(result.nextAttemptAt).getTime() - this.now().getTime(),
            ),
          );
        if (result.phase === 'succeeded' || result.phase === 'empty')
          this.recheck = true;
      }
      await this.foreground();
    } finally {
      this.checking = false;
      if (this.active && delay !== undefined) {
        this.timer = setTimeout(
          () => {
            this.check().catch(this.events.problem);
          },
          this.recheck ? 0 : delay,
        );
        this.timer.unref();
      }
    }
  }
}
