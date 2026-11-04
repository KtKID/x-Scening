import { useEffect, useRef } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import type {
  ArchiveImageReply,
  DailyArchive,
  DailyReviewView,
} from '../../shared/protocol';
import { ArchiveDocument, ARCHIVE_CSS } from '../../shared/daily-archive';
import { useArchiveImageSave } from './useArchiveImageSave';
/** 完整回顾和统计固定为本次档案；按钮与滚动正文独立，导出沿用同一文档。 */
export function DailyReviewModal({
  archive,
  day,
  view,
  saveImage,
  regenerating,
  issue,
  onRegenerate,
  onClose,
  onReturn,
  onPresented,
}: {
  archive: DailyArchive | null;
  day: string;
  view: DailyReviewView | null;
  saveImage: (archive: DailyArchive) => Promise<ArchiveImageReply>;
  regenerating: boolean;
  issue: string | null;
  onRegenerate: () => void;
  onClose: () => void;
  onReturn: () => void;
  onPresented: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { saving, savePicture, feedback } = useArchiveImageSave(
    archive,
    saveImage,
  );
  useEffect(() => {
    const element = dialog.current;
    let frame: number | undefined;
    const show = (): void => {
      if (document.visibilityState !== 'visible' || !document.hasFocus())
        return;
      if (element && !element.open) element.showModal();
      frame = requestAnimationFrame(() => {
        if (
          element?.open &&
          element.matches(':modal') &&
          document.visibilityState === 'visible' &&
          document.hasFocus() &&
          archive &&
          !regenerating
        )
          onPresented();
      });
    };
    show();
    window.addEventListener('focus', show);
    document.addEventListener('visibilitychange', show);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('focus', show);
      document.removeEventListener('visibilitychange', show);
    };
  }, [archive, regenerating, onPresented]);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    return () => {
      element?.close();
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        document.hasFocus()
      )
        opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="daily-review-modal"
      aria-labelledby="daily-review-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <style>{ARCHIVE_CSS}</style>
      <span className="archive-date-tab" aria-hidden="true">
        {day.replaceAll('-', ' · ')}
      </span>
      <div className="archive-reader">
        <button
          className="icon-button archive-close"
          aria-label="关闭每日总结"
          onClick={onClose}
          autoFocus
        >
          <X size={20} />
        </button>
        <div className="archive-scroll">
          {archive ? (
            <ArchiveDocument archive={archive} />
          ) : (
            <div className="daily-summary-state">
              <h2 id="daily-review-title">当日档案</h2>
              <p>
                {regenerating
                  ? '正在生成每日总结'
                  : view?.phase === 'waiting_retry'
                    ? '等待自动重试'
                    : issue
                      ? '总结生成失败'
                      : !view
                        ? '正在读取每日总结'
                        : '当日无记录'}
              </p>
            </div>
          )}
          {regenerating && archive && <p role="status">正在生成每日总结</p>}
          {issue && (
            <div className="daily-error-details" role="alert">
              <strong>总结生成失败</strong>
              {view?.lastError && (
                <p>
                  失败时间：{view.lastError.occurredAt} · 自动已尝试{' '}
                  {view.autoAttempts} 次
                </p>
              )}
              <pre>{issue}</pre>
            </div>
          )}
          {view?.phase === 'waiting_retry' && (
            <p>
              已自动尝试 {view.autoAttempts}/{view.maxAutoAttempts} 次，下次：
              {view.nextAttemptAt}
            </p>
          )}
        </div>
        <footer className="review-actions">
          <button className="text-button review-return" onClick={onReturn}>
            回到时间线
          </button>
          <div className="review-action-buttons">
            <button
              className="archive-regenerate"
              disabled={regenerating || saving}
              onClick={onRegenerate}
            >
              <RefreshCw size={15} />
              {regenerating ? '总结中' : archive ? '重新生成' : '重试生成'}
            </button>
            <button
              className="archive-save"
              disabled={saving || regenerating || !archive}
              onClick={savePicture}
            >
              <Download size={16} />
              {saving ? '保存中' : '保存图片'}
            </button>
          </div>
          <p className="archive-save-feedback" role="status" title={feedback}>
            {feedback}
          </p>
        </footer>
      </div>
    </dialog>
  );
}
