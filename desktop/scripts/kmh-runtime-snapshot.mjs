// profile、生产依赖和既有快照共用同一份本地资料排除规则。
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const privateDirectories = new Set([
  '.git',
  '.cache',
  '.turbo',
  '.aws',
  '.ssh',
  '.docker',
  '.codex',
  '.claude',
  '.kmh',
  '.dsh',
  '.scening',
  '.zcode',
  '.video_agent',
  '__pycache__',
  'sessions-scening',
  'reports',
  'logs',
  'coverage',
  'tests',
  'test',
]);
const privateFiles = new Set([
  '.ds_store',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.boto',
  'credentials.json',
  'auth.json',
  'settings.local.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/** 按相对路径识别凭据、开发资料和主机元数据；SDK的同名代码模块保持可用。 */
export function isPrivateRuntimePath(relative) {
  return relative.split(/[\\/]/).some((value) => {
    const part = value.toLowerCase();
    return (
      privateDirectories.has(part) ||
      privateFiles.has(part) ||
      part.startsWith('.env') ||
      part.startsWith('._') ||
      /^(?:credentials|auth|tokens?|secrets?)(?:\.(?:local|development|production))?\.(?:json|ya?ml|toml|ini)$/.test(
        part,
      ) ||
      /^client_secret.*\.json$/.test(part) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(part) ||
      /\.(?:log|jsonl|pem|key|p12|pfx|tsbuildinfo)$/.test(part) ||
      /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/.test(part)
    );
  });
}

/** 上游复制另排除node_modules；已编译包沿用现有的src裁剪。 */
export function includeRuntimeSource(relative, built = false) {
  const parts = relative.split(/[\\/]/);
  return (
    !isPrivateRuntimePath(relative) &&
    !parts.includes('node_modules') &&
    !(built && parts[0] === 'src')
  );
}

/** 清理物化快照中的本地资料；保留运行依赖链接并逐层检查真实目录。 */
export async function sanitizeRuntimeTree(directory) {
  const removed = [];
  async function visit(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const file = path.join(parent, entry.name);
      const relative = path.relative(directory, file);
      if (isPrivateRuntimePath(relative)) {
        await rm(file, { recursive: true, force: true });
        removed.push(relative);
      } else if (entry.isDirectory()) {
        await visit(file);
      }
    }
  }
  await visit(directory);
  return removed;
}

/** 以中性属主和USTAR写入临时归档，成功后替换；保留执行权限与相对链接。 */
export async function createRuntimeArchive(directory, archive) {
  const pending = `${archive}.tmp-${randomUUID()}`;
  try {
    execFileSync(
      'tar',
      [
        '--no-xattrs',
        '--no-acls',
        '--no-fflags',
        '--format=ustar',
        '--uid',
        '0',
        '--gid',
        '0',
        '--uname',
        '',
        '--gname',
        '',
        '-czf',
        pending,
        '-C',
        directory,
        '.',
      ],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    await rename(pending, archive);
  } finally {
    await rm(pending, { force: true });
  }
}
