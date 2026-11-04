import type { LocalBuildInfo } from './protocol';
import { readLocalBuild } from './check';
import { localClientPaths } from './paths';

type RestartActions = {
  shutdown: () => Promise<void>;
  relaunch: (options: {
    execPath: string;
    args: string[];
  }) => void | Promise<void>;
  quit: () => void;
};

/** 校验固定新包、等待既有退出收尾，再安排原生重启；失败保留窗口并允许重试。 */
export function createLocalClientRestart(
  root: string,
  running: LocalBuildInfo,
  actions: RestartActions,
): () => Promise<void> {
  let pending: Promise<void> | null = null;
  const requireUpdate = async (): Promise<void> => {
    const status = await readLocalBuild(root, running);
    if (status.status === 'unavailable')
      throw new Error('当前客户端应用包尚未完整就绪，请等待构建完成后重试。');
    if (status.status === 'current')
      throw new Error('当前已是最新构建，请等待新的客户端构建完成。');
  };
  return () => {
    if (pending) return pending;
    pending = (async () => {
      await requireUpdate();
      await actions.shutdown();
      await requireUpdate();
      await actions.relaunch({
        execPath: localClientPaths(root).executable,
        args: [],
      });
      actions.quit();
    })().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
