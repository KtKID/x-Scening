import { useEffect, useState } from 'react';
import type { ArchiveImageReply, DailyArchive } from '../../shared/protocol';

type SaveState =
  | { status: 'idle' | 'saving' }
  | { status: 'result'; reply: ArchiveImageReply };

/** 页内阅读与弹窗共用同一份档案图片保存行为。 */
export function useArchiveImageSave(
  archive: DailyArchive | null,
  saveImage: (archive: DailyArchive) => Promise<ArchiveImageReply>,
) {
  const [state, setState] = useState<SaveState>({ status: 'idle' });
  useEffect(() => {
    setState({ status: 'idle' });
  }, [archive]);
  const saving = state.status === 'saving';
  const savePicture = (): void => {
    if (!archive || saving) return;
    setState({ status: 'saving' });
    saveImage(archive)
      .then((reply) => setState({ status: 'result', reply }))
      .catch(() =>
        setState({
          status: 'result',
          reply: {
            status: 'error',
            message: '档案图片保存失败，请重新选择位置后重试。',
          },
        }),
      );
  };
  const feedback =
    state.status !== 'result'
      ? ''
      : state.reply.status === 'saved'
        ? `图片已保存：${state.reply.path}`
        : state.reply.status === 'cancelled'
          ? '已取消保存'
          : state.reply.message;
  return { saving, savePicture, feedback };
}
