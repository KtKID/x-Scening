import { useEffect, useState } from 'react';
import type { ObserverBridge } from '../shared/protocol';
import type { LocalBuildStatus } from './protocol';
import './notice.css';

/** 独立接收本机构建状态，读取异常时保留最近一次成功检查结果。 */
export function LocalBuildNotice({ bridge }: { bridge: ObserverBridge }) {
  const [problem, setProblem] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [status, setStatus] = useState<LocalBuildStatus | null>(null);
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const receive = (next: LocalBuildStatus): void => {
      if (active && next.status !== 'unavailable') setStatus(next);
    };
    const unsubscribe = bridge.onLocalBuild((next) => {
      receivedEvent = true;
      receive(next);
    });
    bridge
      .readLocalBuild()
      .then((next) => {
        if (!receivedEvent) receive(next);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);
  if (status?.status !== 'available') return null;
  return (
    <p className="local-build-notice" role="status">
      新版本 v{status.latest.version} 已就绪（当前 v{status.running.version}
      ），重启即可更新。
      <button
        type="button"
        disabled={restarting}
        onClick={() => {
          setProblem('');
          setRestarting(true);
          bridge.restartLocalClient().catch((error: unknown) => {
            setProblem(error instanceof Error ? error.message : String(error));
            setRestarting(false);
          });
        }}
      >
        {restarting ? '正在重启…' : '重启并更新'}
      </button>
      {problem && <span role="alert">{problem}</span>}
    </p>
  );
}
