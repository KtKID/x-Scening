import { renderToStaticMarkup } from 'react-dom/server';
import { ArchiveDocument, ARCHIVE_CSS } from '../shared/daily-archive';
import { DailyArchiveSchema } from '../shared/protocol';
import type { DailyArchive } from '../shared/protocol';

/** React转义正文，静态页面只包含本地样式；阅读和导出使用同一组件。 */
export function archiveHtml(raw: DailyArchive): string {
  const archive = DailyArchiveSchema.parse(raw);
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>当日档案</title><style>html{margin:0;padding:0;overflow:hidden}' +
    ARCHIVE_CSS +
    '</style></head><body class="archive-image">' +
    renderToStaticMarkup(<ArchiveDocument archive={archive} />) +
    '</body></html>'
  );
}
