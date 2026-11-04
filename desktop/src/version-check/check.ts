import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_BUILD_MARKER, LocalBuildInfoSchema } from './protocol';
import type { LocalBuildInfo, LocalBuildStatus } from './protocol';
import { localClientPaths } from './paths';

/** 固定应用包与成功标记一致时才提示；读取失败在下一轮重新检查。 */
export async function readLocalBuild(
  root: string,
  running: LocalBuildInfo,
): Promise<LocalBuildStatus> {
  try {
    const client = localClientPaths(root);
    const [raw, packaged, executable, archive] = await Promise.all([
      readFile(path.join(root, LOCAL_BUILD_MARKER), 'utf8'),
      readFile(client.info, 'utf8'),
      stat(client.executable),
      stat(client.archive),
    ]);
    const latest = LocalBuildInfoSchema.parse(JSON.parse(raw));
    const installed = LocalBuildInfoSchema.parse(JSON.parse(packaged));
    if (
      latest.buildId !== installed.buildId ||
      latest.version !== installed.version ||
      latest.createdAt !== installed.createdAt ||
      !executable.isFile() ||
      !(archive.isFile() || archive.isDirectory())
    )
      return { status: 'unavailable', running };
    return latest.buildId !== running.buildId &&
      Date.parse(latest.createdAt) > Date.parse(running.createdAt)
      ? { status: 'available', running, latest }
      : { status: 'current', running };
  } catch {
    return { status: 'unavailable', running };
  }
}
