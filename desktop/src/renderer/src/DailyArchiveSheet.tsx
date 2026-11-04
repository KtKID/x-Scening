import { Download, RefreshCw } from 'lucide-react';
import { ArchiveDocument, ARCHIVE_CSS } from '../../shared/daily-archive';
import type { ArchiveImageReply, DailyArchive } from '../../shared/protocol';
import { useArchiveImageSave } from './useArchiveImageSave';

/** 已保存总结直接阅读；生成入口仍调用统一弹窗流程。 */
export function DailyArchiveSheet({
  archive,
  busy,
  onRegenerate,
  saveImage,
}: {
  archive: DailyArchive;
  busy: boolean;
  onRegenerate: () => void;
  saveImage: (archive: DailyArchive) => Promise<ArchiveImageReply>;
}) {
  const { saving, savePicture, feedback } = useArchiveImageSave(
    archive,
    saveImage,
  );
  return (
    <div className="daily-archive-sheet">
      <style>{ARCHIVE_CSS}</style>
      <span className="archive-date-tab" aria-hidden="true">
        {archive.review.day.replaceAll('-', ' · ')}
      </span>
      <div className="archive-reader">
        <ArchiveDocument archive={archive} titleId="daily-summary-page-title" />
        <footer className="review-actions">
          <div className="review-action-buttons">
            <button
              className="archive-regenerate"
              disabled={busy || saving}
              onClick={onRegenerate}
            >
              <RefreshCw size={15} />
              {busy ? '总结中' : '重新生成'}
            </button>
            <button
              className="archive-save"
              disabled={saving || busy}
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
    </div>
  );
}
