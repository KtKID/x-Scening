import { _electron as electron, chromium } from 'playwright';
import type { Browser } from 'playwright';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { z } from 'zod';
import { localClientPaths } from '../src/version-check/paths';
import {
  LOCAL_BUILD_CHECK_INTERVAL_MS,
  LOCAL_BUILD_MARKER,
  LocalBuildInfoSchema,
  LocalBuildStatusSchema,
} from '../src/version-check/protocol';

const execute = promisify(execFile);
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(
  root,
  'reports/local-client-version-notice-20261103',
);
const pictures = path.join(root, 'tmp/local-client-version-notice');
await mkdir(evidence, { recursive: true });
await mkdir(pictures, { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/local-client-window-'));
const client = path.join(temporary, 'desktop');
await mkdir(client);
const errors: string[] = [];
let application: Awaited<ReturnType<typeof electron.launch>> | null = null;
let reopenedBrowser: Browser | null = null;
let reopenedPid: number | undefined;
try {
  await cp(path.join(desktop, 'src'), path.join(client, 'src'), {
    recursive: true,
  });
  for (const file of [
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'tsconfig.json',
  ])
    await cp(path.join(desktop, file), path.join(client, file));
  const viteConfig = path.join(client, 'electron.vite.config.ts');
  await writeFile(
    viteConfig,
    (await readFile(viteConfig, 'utf8')).replace(
      'plugins: [react()],',
      'plugins: [react()], build: { sourcemap: true },',
    ),
  );
  await symlink(
    path.join(desktop, 'node_modules'),
    path.join(client, 'node_modules'),
    'dir',
  );
  await writeFile(
    path.join(temporary, 'observer.yaml'),
    'home: ./home\nscreenshotDir: ./snapshots\n',
  );
  const setVersion = async (version: string) => {
    await execute(
      'npm',
      ['version', version, '--no-git-tag-version', '--allow-same-version'],
      { cwd: client, env: process.env },
    );
  };
  const compile = async (label: string) => {
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', 'src/version-check/build.ts'],
      {
        cwd: client,
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
    );
    await writeFile(
      path.join(evidence, `${label}.log`),
      `${result.stdout}${result.stderr}`.replaceAll(temporary, '<fixture>'),
    );
    return LocalBuildInfoSchema.parse(
      JSON.parse(
        await readFile(path.join(temporary, LOCAL_BUILD_MARKER), 'utf8'),
      ),
    );
  };
  await setVersion('0.1.14');
  const first = await compile('window-build-first');
  const executablePath = localClientPaths(temporary).executable;
  const publishedApp = localClientPaths(temporary).app;
  const appInode = (await stat(publishedApp)).ino;
  application = await electron.launch({
    executablePath,
    args: [],
    env: { ...process.env, OBSERVER_PROJECT_ROOT: temporary },
    timeout: 30000,
  });
  const processId = application.process().pid;
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.reload();
  const readStatus = async () =>
    LocalBuildStatusSchema.parse(
      await page.evaluate(async () => window.observer?.readLocalBuild()),
    );
  const initial = await readStatus();
  {
    const diagnostic = await application.evaluate(({ app }, fixtureRoot) => {
      const fs = process.getBuiltinModule('fs');
      const resources = `${fixtureRoot}/desktop/release/mac-arm64/x-scening.app/Contents/Resources`;
      const archive = fs.statSync(`${resources}/app.asar`);
      const executable = fs.statSync(
        `${fixtureRoot}/desktop/release/mac-arm64/x-scening.app/Contents/MacOS/Observer`,
      );
      return {
        platform: process.platform,
        arch: process.arch,
        projectRoot: process.env.OBSERVER_PROJECT_ROOT,
        appPath: app.getAppPath(),
        archive: {
          file: archive.isFile(),
          directory: archive.isDirectory(),
          size: archive.size,
        },
        executable: executable.isFile(),
        marker: fs.readFileSync(
          `${fixtureRoot}/desktop/.cache/local-client-build.json`,
          'utf8',
        ),
        packaged: fs.readFileSync(
          `${resources}/local-client-build.json`,
          'utf8',
        ),
      };
    }, temporary);
    await writeFile(
      path.join(evidence, 'diagnostic.json'),
      JSON.stringify(diagnostic, null, 2).replaceAll(temporary, '<fixture>'),
    );
  }
  assert.equal(initial.status, 'current');
  console.log(JSON.stringify({ stage: 'first-ready' }));
  assert.equal(initial.running.buildId, first.buildId);
  assert.equal(await page.locator('.local-build-notice').count(), 0);
  const marker = path.join(temporary, LOCAL_BUILD_MARKER);
  await writeFile(marker, '{');
  assert.equal((await readStatus()).status, 'unavailable');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  const started = Date.now();
  await setVersion('0.1.15');
  const second = await compile('window-build-second');
  assert.notEqual(second.buildId, first.buildId);
  assert.equal((await stat(publishedApp)).ino, appInode);
  assert.equal(first.version, '0.1.14');
  assert.equal(second.version, '0.1.15');
  const available = await readStatus();
  assert.equal(available.status, 'available');
  assert.equal(available.running.buildId, first.buildId);
  await page
    .getByRole('status')
    .filter({ hasText: `v${second.version}` })
    .waitFor({
      timeout: LOCAL_BUILD_CHECK_INTERVAL_MS + 10000,
    });
  const elapsedMs = Date.now() - started;
  console.log(JSON.stringify({ stage: 'detected', elapsedMs }));
  await writeFile(
    path.join(evidence, 'detection.json'),
    JSON.stringify(
      {
        first,
        second,
        elapsedMs,
        pidUnchanged: application.process().pid === processId,
      },
      null,
      2,
    ),
  );
  assert.equal(application.process().pid, processId);
  assert.match(
    await page.locator('.local-build-notice').innerText(),
    /重启即可更新/,
  );
  const noticeText = await page.locator('.local-build-notice').innerText();
  await page.screenshot({ path: path.join(pictures, 'versions.png') });
  assert.ok(
    noticeText.includes(
      `新版本 v${second.version} 已就绪（当前 v${first.version}）`,
    ),
    `更新提示应同时显示目标版本和当前版本，实际：${noticeText}`,
  );
  const coverageDirectory = path.join(evidence, 'coverage');
  await mkdir(coverageDirectory, { recursive: true });
  await writeFile(
    path.join(coverageDirectory, 'renderer.json'),
    JSON.stringify(await page.coverage.stopJSCoverage(), null, 2),
  );
  await cp(
    path.join(client, 'out/renderer/assets'),
    path.join(coverageDirectory, 'assets'),
    { recursive: true },
  );
  const restartButton = page.getByRole('button', {
    name: '重启并更新',
    exact: true,
  });
  await writeFile(marker, '{');
  await restartButton.click();
  const problem = page
    .getByRole('alert')
    .filter({ hasText: '应用包尚未完整就绪' });
  await problem.waitFor();
  const fullFailure = await problem.innerText();
  assert.equal(await restartButton.isEnabled(), true);
  assert.equal(application.process().exitCode, null);
  await page.screenshot({ path: path.join(pictures, 'notice.png') });
  await writeFile(marker, JSON.stringify(second));
  // 仅为自动重开的夹具附加本机调试端口；原生relaunch与quit均真实执行。
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const relaunchFile = path.join(temporary, 'relaunched.json');
  await application.evaluate(
    ({ app }, { file, port }) => {
      const { writeFileSync } = process.getBuiltinModule('fs');
      const nativeRelaunch = app.relaunch.bind(app);
      app.relaunch = (options) => {
        writeFileSync(file, JSON.stringify(options));
        nativeRelaunch({
          ...options,
          args: [`--remote-debugging-port=${port}`],
        });
      };
    },
    { file: relaunchFile, port },
  );
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('点击更新后原进程未退出')),
      30000,
    );
    application?.process().once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await restartButton.click();
  await exited;
  application = null;
  const options = z
    .object({ execPath: z.string(), args: z.array(z.string()) })
    .parse(JSON.parse(await readFile(relaunchFile, 'utf8')));
  assert.deepEqual(options, { execPath: executablePath, args: [] });
  for (let attempt = 0; attempt < 100 && !reopenedBrowser; attempt++) {
    reopenedBrowser = await chromium
      .connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 })
      .catch(() => null);
    if (!reopenedBrowser)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(reopenedBrowser, '点击按钮后应自动打开新版本');
  const session = await reopenedBrowser.newBrowserCDPSession();
  const processInfo: unknown = await session.send('SystemInfo.getProcessInfo');
  const processes = z
    .object({
      processInfo: z.array(z.object({ type: z.string(), id: z.number() })),
    })
    .parse(processInfo);
  reopenedPid = processes.processInfo.find((row) => row.type === 'browser')?.id;
  assert.ok(reopenedPid);
  assert.notEqual(reopenedPid, processId);
  const context = reopenedBrowser.contexts()[0];
  assert.ok(context);
  const reopened = context.pages()[0] ?? (await context.waitForEvent('page'));
  reopened.on('pageerror', (error) => errors.push(error.message));
  await reopened.waitForFunction(() => window.observer !== undefined);
  const loaded = LocalBuildStatusSchema.parse(
    await reopened.evaluate(async () => window.observer?.readLocalBuild()),
  );
  assert.equal(loaded.status, 'current');
  assert.equal(loaded.running.buildId, second.buildId);
  assert.equal(await reopened.locator('.local-build-notice').count(), 0);
  await reopened.screenshot({ path: path.join(pictures, 'restarted.png') });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'window.json'),
    JSON.stringify(
      {
        first,
        second,
        noticeText,
        elapsedMs,
        pidUnchanged: true,
        fixedApp: 'desktop/release/mac-arm64/x-scening.app',
        restartTargetCorrect: true,
        originalPid: processId,
        restartedPid: reopenedPid,
        originalExited: true,
        failurePreservedWindow: true,
        fullFailure,
        appDirectoryIdentityUnchanged: true,
        restartedBuildMatches: true,
        errors,
        checks: [
          {
            id: 'T4',
            result:
              '同一路径第二次真实编译及打包完成后，原包进程经60秒检查显示提示，运行标识保持首份构建。',
          },
          {
            id: 'T5',
            result:
              '坏标记点击显示完整原因且保留窗口，修复后点击原生重启自动打开同一入口并加载第二份构建，页面异常0。',
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      checks: 2,
      elapsedMs,
      pidUnchanged: true,
      errors: errors.length,
    }),
  );
} finally {
  if (application) await application.close();
  if (reopenedBrowser) await reopenedBrowser.close();
  if (reopenedPid) {
    try {
      process.kill(reopenedPid, 'SIGTERM');
    } catch {
      /* 夹具可能已自行退出。 */
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(reopenedPid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
