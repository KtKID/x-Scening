import { BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DailyArchiveSchema } from '../shared/protocol';
import type { ArchiveImageReply, DailyArchive } from '../shared/protocol';
import { ARCHIVE_IMAGE_WIDTH } from '../shared/daily-archive';
import { archiveHtml } from './archive-html';
import { withReason } from './diagnostics';

// Chromium单张位图边长预算；超限明确报错，正文继续完整保留。
const MAX_IMAGE_HEIGHT = 32760;
/** 原生保存对话框与全文PNG渲染；每次仅允许一个导出，原数据保持只读。 */
export class ArchiveImageExporter {
  private saving = false;
  async save(
    owner: BrowserWindow,
    raw: DailyArchive,
  ): Promise<ArchiveImageReply> {
    if (this.saving)
      return { status: 'error', message: '档案图片正在保存，请等待本次完成。' };
    this.saving = true;
    let renderer: BrowserWindow | undefined;
    let temporary: string | undefined;
    try {
      const archive = DailyArchiveSchema.parse(raw);
      const chosen = await dialog.showSaveDialog(owner, {
        title: '保存当日档案',
        defaultPath: `Observer-${archive.review.day}${archive.source === 'demo' ? '-测试数据' : ''}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' };
      renderer = new BrowserWindow({
        show: false,
        width: ARCHIVE_IMAGE_WIDTH,
        height: 800,
        useContentSize: true,
        backgroundColor: '#f5eedc',
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      renderer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await renderer.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(archiveHtml(archive)),
      );
      const measured: unknown = await renderer.webContents.executeJavaScript(
        'document.fonts.ready.then(() => Math.ceil(document.documentElement.scrollHeight))',
      );
      const height = z
        .number()
        .int()
        .positive()
        .max(MAX_IMAGE_HEIGHT)
        .parse(measured);
      renderer.setContentSize(ARCHIVE_IMAGE_WIDTH, height);
      await renderer.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      const bitmap = await renderer.webContents.capturePage(
        { x: 0, y: 0, width: ARCHIVE_IMAGE_WIDTH, height },
        { stayHidden: true, stayAwake: true },
      );
      if (bitmap.isEmpty()) throw new Error('图片渲染为空');
      const image = bitmap.resize({ width: ARCHIVE_IMAGE_WIDTH }).toPNG();
      const destination = chosen.filePath;
      temporary = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.${randomUUID()}.tmp`,
      );
      await writeFile(temporary, image, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      temporary = undefined;
      return { status: 'saved', path: destination };
    } catch (error: unknown) {
      return {
        status: 'error',
        message: withReason(
          '档案图片保存失败，请检查保存位置、磁盘空间或正文长度后重试；已有文件保持原样',
          error,
        ),
      };
    } finally {
      renderer?.destroy();
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      this.saving = false;
    }
  }
}
