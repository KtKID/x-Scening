import { extractFile, uncache } from '@electron/asar';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { LocalBuildInfoSchema } from './version-check/protocol';
import { localClientPaths } from './version-check/paths';

const execute = promisify(execFile);
export const ReleaseTagSchema = z.string().regex(/^v\d+\.\d+\.\d+$/);
const VersionSchema = LocalBuildInfoSchema.pick({ version: true }).strip();
const IconNameSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/);
export const ReleaseInfoSchema = z.strictObject({
  tag: ReleaseTagSchema,
  version: LocalBuildInfoSchema.shape.version,
  mode: z.literal('publish'),
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
  buildId: LocalBuildInfoSchema.shape.buildId,
});
export const ReleaseManifestSchema = ReleaseInfoSchema.extend({
  archive: z.string().regex(/^x-scening-v\d+\.\d+\.\d+-macOS-arm64\.zip$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** 标签版本由源码和实际包共同校验，格式或版本不符时终止发布。 */
export function checkReleaseTag(tag: string, version: string): void {
  ReleaseTagSchema.parse(tag);
  LocalBuildInfoSchema.shape.version.parse(version);
  if (tag !== `v${version}`)
    throw new Error(
      `Release标签${tag}要求版本${tag.slice(1)}，当前版本为${version}`,
    );
}

/** 从主进程实际编译内容核对唯一的模式注入点，dev及缺失/多重注入均拒绝。 */
export function checkPublishMode(main: string): void {
  const modes = [
    ...main.matchAll(
      /RuntimeModeSchema\s*\.\s*parse\s*\(\s*['"](dev|publish)['"]\s*\)/g,
    ),
  ];
  if (modes.length !== 1 || modes[0]?.[1] !== 'publish')
    throw new Error('Release包要求唯一的publish模式编译注入');
}

async function plistValue(file: string, key: string): Promise<string> {
  return (
    await execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file])
  ).stdout.trim();
}

/** 核对实际macOS应用的ASAR、标签版本、构建标记、图标和可执行架构。
 * 参数为.app路径及版本标签；只读产物，任一校验失败向调用方抛错。
 */
export async function verifyMacRelease(app: string, tag: string) {
  ReleaseTagSchema.parse(tag);
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Release核验使用macOS arm64环境');
  const resources = path.join(app, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  uncache(archive);
  const packageRaw: unknown = JSON.parse(
    extractFile(archive, 'package.json').toString('utf8'),
  );
  const { version } = VersionSchema.parse(packageRaw);
  checkReleaseTag(tag, version);
  const main = extractFile(archive, 'out/main/index.js').toString('utf8');
  checkPublishMode(main);
  const buildRaw: unknown = JSON.parse(
    await readFile(path.join(resources, 'local-client-build.json'), 'utf8'),
  );
  const build = LocalBuildInfoSchema.parse(buildRaw);
  if (build.version !== version || !main.includes(build.buildId))
    throw new Error('应用构建标记须与包内版本及本轮主进程一致');
  const plist = path.join(app, 'Contents/Info.plist');
  if ((await plistValue(plist, 'CFBundleShortVersionString')) !== version)
    throw new Error('应用Info.plist版本须与Release版本一致');
  const iconName = IconNameSchema.parse(
    await plistValue(plist, 'CFBundleIconFile'),
  );
  const icon = await readFile(
    path.join(
      resources,
      iconName.endsWith('.icns') ? iconName : `${iconName}.icns`,
    ),
  );
  if (icon.length <= 8 || icon.subarray(0, 4).toString() !== 'icns')
    throw new Error('Release包要求有效的产品icns图标');
  const executable = path.join(app, 'Contents/MacOS/Observer');
  if (!(await stat(executable)).isFile())
    throw new Error('Release可执行文件须完整就绪');
  const architectures = (
    await execute('/usr/bin/lipo', ['-archs', executable])
  ).stdout
    .trim()
    .split(/\s+/);
  if (!architectures.includes('arm64'))
    throw new Error('Release可执行文件要求arm64架构');
  return ReleaseInfoSchema.parse({
    tag,
    version,
    mode: 'publish',
    platform: 'darwin',
    arch: 'arm64',
    buildId: build.buildId,
  });
}

/** 核验后压缩，再解压回读同一构建；最后保存ZIP、manifest和SHA256。
 * 输出目录由调用方提供，临时文件失败时清理；Release上传由工作流后续job负责。
 */
export async function createReleaseArchive(
  app: string,
  tag: string,
  output: string,
) {
  const info = await verifyMacRelease(app, tag);
  await mkdir(output, { recursive: true });
  const name = `x-scening-${tag}-macOS-arm64.zip`;
  const temporary = path.join(output, `.${randomUUID()}.zip`);
  const extracted = await mkdtemp(path.join(output, '.verify-'));
  try {
    await execute('/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      app,
      temporary,
    ]);
    await execute('/usr/bin/ditto', ['-x', '-k', temporary, extracted]);
    const reread = await verifyMacRelease(
      path.join(extracted, path.basename(app)),
      tag,
    );
    if (reread.buildId !== info.buildId)
      throw new Error('ZIP回读要求同一构建标识');
    const sha256 = createHash('sha256')
      .update(await readFile(temporary))
      .digest('hex');
    const manifest = ReleaseManifestSchema.parse({
      ...info,
      archive: name,
      sha256,
    });
    const manifestName = name.replace(/\.zip$/, '.json');
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha = createHash('sha256').update(content).digest('hex');
    await rename(temporary, path.join(output, name));
    await writeFile(path.join(output, manifestName), content);
    await writeFile(
      path.join(output, 'SHA256SUMS.txt'),
      `${sha256}  ${name}\n${manifestSha}  ${manifestName}\n`,
    );
    return manifest;
  } finally {
    await rm(temporary, { force: true });
    await rm(extracted, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: 'string' },
      app: { type: 'string' },
      output: { type: 'string' },
    },
  });
  const command = z
    .enum(['check-tag', 'verify', 'archive'])
    .parse(positionals[0]);
  const tag = ReleaseTagSchema.parse(values.tag);
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const metadata: unknown = JSON.parse(
    await readFile(path.join(root, 'desktop/package.json'), 'utf8'),
  );
  checkReleaseTag(tag, VersionSchema.parse(metadata).version);
  const app = values.app
    ? path.resolve(values.app)
    : localClientPaths(root).app;
  if (command === 'check-tag') console.log(`Release标签与源版本一致：${tag}`);
  else if (command === 'verify')
    console.log(JSON.stringify(await verifyMacRelease(app, tag), null, 2));
  else
    console.log(
      JSON.stringify(
        await createReleaseArchive(
          app,
          tag,
          values.output
            ? path.resolve(values.output)
            : path.join(root, 'desktop/release-assets'),
        ),
        null,
        2,
      ),
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
