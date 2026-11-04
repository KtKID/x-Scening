import { useCallback, useEffect, useRef, useState } from 'react';
import { buildDailyArchive } from '../../shared/daily-archive';
import { localDay, moveDay } from '../../shared/protocol';
import type {
  DailyArchive,
  DailyReviewView,
  ObserverBridge,
  Source,
} from '../../shared/protocol';

export type ReviewDialog = {
  day: string;
  source: Source;
  archive: DailyArchive | null;
  view: DailyReviewView | null;
  busy: boolean;
  issue: string | null;
};

/** 所有触发共用读取、生成、弹窗与回执；当前页面位置保持独立。 */
export function useDailyReviewDialog(bridge: ObserverBridge, source: Source) {
  const [dialog, setDialog] = useState<ReviewDialog | null>(null);
  const current = useRef<ReviewDialog | null>(null);
  const revision = useRef(0);
  const confirming = useRef(false);
  const queued = useRef(new Map<string, DailyReviewView>());
  const update = useCallback((value: ReviewDialog | null) => {
    current.current = value;
    setDialog(value);
  }, []);

  /** 直接展示页面已构建的完整档案，递增代次使先前异步读取失效。 */
  const show = useCallback(
    (archive: DailyArchive, view: DailyReviewView | null): void => {
      revision.current++;
      const matching =
        archive.source === 'local' && view?.day === archive.review.day
          ? view
          : null;
      update({
        day: archive.review.day,
        source: archive.source,
        archive,
        view: matching,
        busy: matching?.phase === 'running',
        issue:
          matching?.lastError?.details ?? matching?.lastError?.message ?? null,
      });
    },
    [update],
  );

  const open = useCallback(
    async (
      day: string,
      selectedSource: Source,
      generate = false,
      supplied?: DailyReviewView,
    ): Promise<void> => {
      const request = ++revision.current;
      const previous = current.current;
      update({
        day,
        source: selectedSource,
        archive:
          previous?.day === day && previous.source === selectedSource
            ? previous.archive
            : null,
        view: supplied ?? null,
        busy: generate || supplied?.phase === 'running',
        issue: null,
      });
      try {
        const snapshot = await bridge.readDay({ day, source: selectedSource });
        const tasks = await bridge
          .readTaskTimeline({
            day,
            source: selectedSource,
            expectedSourceRevision: snapshot.sourceRevision,
            refreshReason: 'auto',
          })
          .catch(() => null);
        const apply = (
          view: DailyReviewView | null,
          archive: DailyArchive | null,
          busy: boolean,
          issue: string | null,
        ): void => {
          if (request === revision.current)
            update({ day, source: selectedSource, view, archive, busy, issue });
        };
        if (selectedSource === 'demo') {
          const reply = await bridge.readDailyReview({
            day,
            source: selectedSource,
            refresh: generate,
            cachedOnly: !generate,
          });
          apply(
            null,
            reply.status === 'ready'
              ? buildDailyArchive(
                  reply.review,
                  snapshot,
                  tasks,
                  new Date().toISOString(),
                )
              : null,
            false,
            reply.status === 'ready' ? null : reply.message,
          );
          return;
        }
        let view = supplied ?? (await bridge.readDailyReviewState({ day }));
        const applyView = (
          value: DailyReviewView,
          busy = value.phase === 'running',
        ): void => {
          apply(
            value,
            value.report
              ? buildDailyArchive(
                  value.report,
                  snapshot,
                  tasks,
                  new Date().toISOString(),
                )
              : null,
            busy,
            value.lastError?.details ?? value.lastError?.message ?? null,
          );
        };
        applyView(view, generate || view.phase === 'running');
        if (generate) {
          view = await bridge.generateDailyReview({ day, homeId: view.homeId });
          applyView(view);
        }
      } catch (error: unknown) {
        if (request === revision.current && current.current)
          update({
            ...current.current,
            busy: false,
            issue: error instanceof Error ? error.message : String(error),
          });
      }
    },
    [bridge, update],
  );

  const offer = useCallback(
    (view: DailyReviewView) => {
      const active = current.current;
      if (active && (active.day !== view.day || active.source !== 'local')) {
        queued.current.set(view.day, view);
        return;
      }
      open(view.day, 'local', false, view).catch(console.error);
    },
    [open],
  );

  useEffect(
    () =>
      bridge.onDailyReviewOpen((view) => {
        if (source === 'local') offer(view);
      }),
    [bridge, source, offer],
  );
  useEffect(
    () =>
      bridge.onDailyReviewChanged((view) => {
        if (source !== 'local' || view.phase === 'empty') return;
        if (view.report || current.current?.day === view.day) offer(view);
      }),
    [bridge, source, offer],
  );

  // 外部生成和自动重试沿用同一份弹窗状态，打开期间持续读取所属日期。
  useEffect(() => {
    if (
      !dialog ||
      dialog.source !== 'local' ||
      !['running', 'waiting_retry'].includes(dialog.view?.phase ?? '')
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    bridge
      .readSettings()
      .then((settings) => {
        if (!active) return;
        timer = setTimeout(() => {
          bridge
            .readDailyReviewState({ day: dialog.day })
            .then((view) => {
              if (active) offer(view);
            })
            .catch(console.error);
        }, settings.config.desktop.refreshIntervalSeconds * 1000);
      })
      .catch(console.error);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [bridge, dialog, offer]);

  const close = useCallback(() => {
    revision.current++;
    update(null);
    const next = queued.current.entries().next().value;
    if (next) {
      queued.current.delete(next[0]);
      offer(next[1]);
    }
  }, [offer, update]);
  const presented = useCallback(() => {
    const value = current.current;
    if (
      confirming.current ||
      !value ||
      value.source !== 'local' ||
      value.busy ||
      !value.archive ||
      !value.view ||
      value.view.phase !== 'succeeded' ||
      value.day !== moveDay(localDay(), -1) ||
      value.view.presentedOn === localDay()
    )
      return;
    const request = revision.current;
    confirming.current = true;
    bridge
      .markDailyReviewPresented({
        day: value.day,
        revision: value.view.revision,
        homeId: value.view.homeId,
      })
      .then((view) => {
        if (request === revision.current && current.current)
          update({ ...current.current, view });
      })
      .catch((error: unknown) => {
        if (request === revision.current && current.current)
          update({
            ...current.current,
            issue: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => {
        confirming.current = false;
      });
  }, [bridge, update]);
  const regenerate = useCallback(() => {
    const value = current.current;
    if (value && !value.busy)
      open(value.day, value.source, true).catch(console.error);
  }, [open]);
  return { dialog, show, open, close, presented, regenerate };
}
