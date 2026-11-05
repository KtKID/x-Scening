import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CaptureController } from '../src/main/capture';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const project = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fake = await readFile(
  path.join(project, 'desktop/tests/fixtures/capture.py'),
  'utf8',
);
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  await mkdir(path.join(project, 'tmp'), { recursive: true });
  const root = await mkdtemp(path.join(project, 'tmp/capture-unit-'));
  try {
    await mkdir(path.join(root, '.venv/bin'), { recursive: true });
    await mkdir(path.join(root, 'src/scening'), { recursive: true });
    await writeFile(
      path.join(root, 'src/scening/__init__.py'),
      `__path__.append(${JSON.stringify(path.join(project, 'src/scening'))})`,
    );
    await writeFile(path.join(root, 'src/scening/observe_activity.py'), fake);
    await symlink(
      path.join(project, '.venv/bin/python'),
      path.join(root, '.venv/bin/python'),
    );
    await symlink(
      path.join(project, '.venv/lib'),
      path.join(root, '.venv/lib'),
    );
    await symlink(
      path.join(project, '.venv/pyvenv.cfg'),
      path.join(root, '.venv/pyvenv.cfg'),
    );
    const config = parseDocument(
      await readFile(path.join(project, 'observer.yaml'), 'utf8'),
    );
    config.set('home', './home');
    config.setIn(['desktop', 'refreshIntervalSeconds'], 0.05);
    await writeFile(path.join(root, 'observer.yaml'), config.toString());
    try {
      await run(root);
    } catch (error) {
      const output = await readFile(
        path.join(root, 'desktop/.cache/capture.log'),
        'utf8',
      ).catch(() => '本例尚未创建采集日志');
      await mkdir(path.join(project, 'reports/fix/analysis-control-20261028'), {
        recursive: true,
      });
      await writeFile(
        path.join(
          project,
          'reports/fix/analysis-control-20261028',
          `${path.basename(root)}.log`,
        ),
        output,
      );
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function untilStopped(control: CaptureController): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await control.read()).capture.state === 'stopped') return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail('采集应完成退出');
}
await test('C1 启停幂等、进程退出及启动错误恢复', async () => {
  await fixture(async (root) => {
    const control = new CaptureController(root);
    assert.equal((await control.read()).capture.state, 'stopped');
    try {
      const [a, b] = await Promise.all([control.start(), control.start()]);
      assert.ok('pid' in a.capture && 'pid' in b.capture);
      assert.equal(a.capture.pid, b.capture.pid);
      assert.equal(a.capture.origin, 'client');
      await untilReady(control);
      assert.equal((await control.read()).capture.state, 'running');
    } finally {
      await control.stop();
      await untilStopped(control);
    }
    await rm(path.join(root, '.venv/bin/python'));
    assert.equal((await control.start()).capture.state, 'error');
    assert.equal((await control.read()).capture.state, 'error');
  });
});

async function untilReady(control: CaptureController): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await control.read()).capture.state === 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail('采集应就绪');
}

await test('顶部保留保存信息与待拼图数量，完整路径留在原始日志', async () => {
  await fixture(async (root) => {
    const home = path.join(root, 'home');
    const screenshot = path.join(home, '带空格的 截图', '2026-11-05_m1.jpg');
    await mkdir(home, { recursive: true });
    await writeFile(
      path.join(home, 'progress.json'),
      JSON.stringify([
        {
          stage: 'image_prepare',
          result: 'saved',
          screenshot,
          originalSize: [2560, 1440],
          display: 1,
        },
        {
          stage: 'scening',
          result: 'candidate',
          screenshot,
          message: '候选已选出',
        },
        { stage: 'analysis', result: 'started', mini: screenshot },
        {
          stage: 'analysis_batch',
          result: 'pending',
          pendingCount: 2,
          batchSize: 3,
        },
      ]),
    );
    const control = new CaptureController(root);
    const messages: string[] = [];
    const unsubscribe = control.subscribe(({ capture }) => {
      messages.push(capture.message);
    });
    try {
      await control.start();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (messages.some((message) => message.includes('2/3'))) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(
        messages.some((message) =>
          /候选 JPEG 已保存；原分辨率 \[2560, 1440\]；屏幕 1/.test(message),
        ),
      );
      assert.ok(messages.some((message) => message.endsWith('KMH 分析中')));
      assert.ok(
        messages.some((message) => message.endsWith('分析待凑图：2/3')),
      );
      assert.ok(messages.every((message) => !message.includes('目标路径')));
      assert.ok(messages.every((message) => !message.includes(screenshot)));
    } finally {
      unsubscribe();
      await control.shutdown();
    }
    assert.ok(
      (
        await readFile(path.join(root, 'desktop/.cache/capture.log'), 'utf8')
      ).includes(screenshot),
    );
  });
});

await test('C8 停止时选择仅截图，真实启动参数生效且相同选择保持PID', async () => {
  await fixture(async (root) => {
    const control = new CaptureController(root);
    try {
      assert.equal((await control.read()).analysisEnabled, true);
      const disabled = await control.setAnalysisEnabled(false);
      assert.equal(disabled.analysisEnabled, false);
      assert.equal(disabled.capture.state, 'stopped');
      const started = await control.start();
      assert.ok('pid' in started.capture);
      assert.equal(started.capture.mode, 'capture-only');
      await untilReady(control);
      assert.ok(
        (
          await readFile(path.join(root, 'home/launch-args.json'), 'utf8')
        ).includes('"--capture-only"'),
      );
      const again = await control.setAnalysisEnabled(false);
      assert.ok('pid' in again.capture);
      assert.equal(again.capture.pid, started.capture.pid);
    } finally {
      await control.shutdown();
    }
    assert.equal((await control.read()).analysisEnabled, false);
  });
});

await test('C9 运行中关闭分析，1秒内生效且Python进程保持', async () => {
  await fixture(async (root) => {
    const control = new CaptureController(root);
    try {
      const first = await control.start();
      assert.ok('pid' in first.capture);
      const firstPid = first.capture.pid;
      await untilReady(control);
      const began = performance.now();
      const disabled = await control.setAnalysisEnabled(false);
      const elapsed = performance.now() - began;
      assert.ok('pid' in disabled.capture);
      assert.equal(
        disabled.capture.pid,
        firstPid,
        '关闭分析应保持同一Python采集进程',
      );
      assert.equal(disabled.capture.state, 'running');
      assert.equal(disabled.capture.mode, 'capture-only');
      assert.equal(disabled.analysisEnabled, false);
      assert.ok(
        elapsed < 1000,
        `关闭分析耗时${elapsed.toFixed(1)}ms，应小于1秒`,
      );
      assert.doesNotThrow(() => process.kill(firstPid, 0));
      assert.equal(
        await readFile(path.join(root, 'home/launched-pids'), 'utf8'),
        `${String(firstPid)}\n`,
        '关闭分析期间Python启动次数应保持一次',
      );
      const again = await control.setAnalysisEnabled(false);
      assert.ok('pid' in again.capture);
      assert.equal(again.capture.pid, firstPid);
    } finally {
      await control.shutdown();
    }
  });
});

await test('C12 仅截图运行中开启分析，1秒内生效且Python进程保持', async () => {
  await fixture(async (root) => {
    const control = new CaptureController(root);
    try {
      await control.setAnalysisEnabled(false);
      const first = await control.start();
      assert.ok('pid' in first.capture);
      assert.equal(first.capture.mode, 'capture-only');
      const firstPid = first.capture.pid;
      await untilReady(control);
      const began = performance.now();
      const enabled = await control.setAnalysisEnabled(true);
      const elapsed = performance.now() - began;
      assert.ok('pid' in enabled.capture);
      assert.equal(
        enabled.capture.pid,
        firstPid,
        '开启分析应保持同一Python采集进程',
      );
      assert.equal(enabled.capture.state, 'running');
      assert.equal(enabled.capture.mode, 'full');
      assert.equal(enabled.analysisEnabled, true);
      assert.ok(
        elapsed < 1000,
        `开启分析耗时${elapsed.toFixed(1)}ms，应小于1秒`,
      );
      assert.doesNotThrow(() => process.kill(firstPid, 0));
      assert.equal(
        await readFile(path.join(root, 'home/launched-pids'), 'utf8'),
        `${String(firstPid)}\n`,
        '开启分析期间Python启动次数应保持一次',
      );
    } finally {
      await control.shutdown();
    }
  });
});

await test('C13 外部状态查询与启动交错，旧查询保持新进程状态及可停止性', async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, 'home'), { recursive: true });
    await writeFile(path.join(root, 'home/observer.lock'), '');
    const control = new CaptureController(root);
    try {
      const starting = control.start();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const reads = Array.from({ length: 8 }, () => control.read());
      const first = await starting;
      assert.ok('pid' in first.capture);
      await Promise.all(reads);
      await untilReady(control);
      const current = await control.read();
      assert.ok('pid' in current.capture);
      assert.equal(current.capture.pid, first.capture.pid);
      assert.equal((await control.stop()).capture.state, 'stopped');
      assert.equal(control.ownsProcess, false);
    } finally {
      await control.shutdown();
    }
  });
});

await test('C10 同home外部进程开启分析，身份核对后保持原Python进程', async () => {
  await fixture(async (root) => {
    const child = spawn(
      path.join(root, '.venv/bin/python'),
      ['-B', '-m', 'scening.observe_activity', '--capture-only'],
      {
        cwd: root,
        env: { ...process.env, PYTHONPATH: path.join(root, 'src') },
      },
    );
    const closed = once(child, 'close');
    const control = new CaptureController(root);
    try {
      await once(child.stdout, 'data');
      assert.equal((await control.read()).analysisEnabled, false);
      const edited = parseDocument(
        await readFile(path.join(root, 'observer.yaml'), 'utf8'),
      );
      edited.set('home', './next-home');
      await writeFile(path.join(root, 'observer.yaml'), edited.toString());
      const afterSave = await control.read();
      assert.ok('pid' in afterSave.capture);
      assert.equal(
        afterSave.capture.pid,
        child.pid,
        '保存新home后继续控制原独立进程',
      );
      const began = performance.now();
      const enabled = await control.setAnalysisEnabled(true);
      const elapsed = performance.now() - began;
      assert.ok('pid' in enabled.capture);
      assert.equal(
        enabled.capture.pid,
        child.pid,
        '外部Python采集进程也应原地切换分析开关',
      );
      assert.equal(enabled.capture.origin, 'external');
      assert.equal(enabled.capture.mode, 'full');
      assert.equal(child.exitCode, null);
      assert.ok(
        elapsed < 1000,
        `外部进程开启分析耗时${elapsed.toFixed(1)}ms，应小于1秒`,
      );
      assert.equal(
        await readFile(path.join(root, 'home/launched-pids'), 'utf8'),
        `${String(child.pid)}\n`,
      );
      await control.stop();
      await closed;
      assert.equal(child.exitCode, 0, '修改home后仍可停止原独立进程');
      const restarted = await control.start();
      assert.ok('pid' in restarted.capture);
      await untilReady(control);
      assert.equal(
        await readFile(path.join(root, 'next-home/launched-pids'), 'utf8'),
        `${String(restarted.capture.pid)}\n`,
        '下一次启动读取新home',
      );
    } finally {
      await control.shutdown();
      child.kill('SIGTERM');
      await closed;
    }
  });
});

await test('C11 切换模式期间退出，等待最终受管进程完成回收', async () => {
  await fixture(async (root) => {
    await writeFile(
      path.join(root, 'src/scening/observe_activity.py'),
      fake.replace('# delayed-stop', 'time.sleep(0.1)'),
    );
    const control = new CaptureController(root);
    try {
      await control.start();
      await untilReady(control);
      const switching = control.setAnalysisEnabled(false);
      const quitting = control.shutdown();
      await Promise.all([switching, quitting]);
      assert.equal(control.ownsProcess, false);
      assert.equal((await control.read()).capture.state, 'stopped');
    } finally {
      await control.shutdown();
    }
  });
});
await test('C2 同目录独立采集识别、复用、显式停止；无关进程保持', async () => {
  await fixture(async (root) => {
    const child = spawn(
      path.join(root, '.venv/bin/python'),
      ['-B', '-m', 'scening.observe_activity', '--capture-only'],
      {
        cwd: root,
        env: { ...process.env, PYTHONPATH: path.join(root, 'src') },
      },
    );
    try {
      await once(child.stdout, 'data');
      const control = new CaptureController(root);
      const current = (await control.read()).capture;
      assert.ok('pid' in current);
      assert.equal(current.pid, child.pid);
      assert.equal(current.origin, 'external');
      assert.equal(current.mode, 'capture-only');
      await control.shutdown();
      assert.equal(child.exitCode, null);
      const again = (await control.start()).capture;
      assert.ok('pid' in again);
      assert.equal(again.pid, child.pid);
      await control.stop();
      await untilStopped(control);
      process.kill(process.pid, 0);
    } finally {
      child.kill('SIGTERM');
    }
  });
});

await test('C3 无关的锁文件持有者保持运行', async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, 'home'));
    const child = spawn(
      path.join(root, '.venv/bin/python'),
      [
        '-u',
        '-c',
        "import pathlib,time; f=pathlib.Path('home/observer.lock').open('a'); print('ready',flush=True); time.sleep(30)",
      ],
      { cwd: root },
    );
    try {
      await once(child.stdout, 'data');
      const control = new CaptureController(root);
      assert.equal((await control.stop()).capture.state, 'stopped');
      assert.equal(child.exitCode, null);
      process.kill(child.pid ?? 0, 0);
    } finally {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
  });
});

await test('C4 启动中立即停止也能正常收尾', async () => {
  await fixture(async (root) => {
    const control = new CaptureController(root);
    await control.start();
    await control.stop();
    try {
      await untilStopped(control);
    } finally {
      await control.shutdown();
    }
  });
});

await test('C5 显式旧配置从项目YAML读取桌面间隔，非法间隔可定位', async () => {
  await fixture(async (root) => {
    const config = path.join(root, 'legacy.yaml');
    await writeFile(config, 'home: ./other-home\n');
    assert.equal(
      (await new CaptureController(root, config).read()).refreshIntervalSeconds,
      0.05,
    );
    await writeFile(
      config,
      'home: ./home\ndesktop:\n  refreshIntervalSeconds: 0\n',
    );
    await assert.rejects(
      new CaptureController(root, config).read(),
      /refreshIntervalSeconds/,
    );
  });
});

await test('C6 运行中配置损坏仍可停止并退出', async () => {
  await fixture(async (root) => {
    const control = new CaptureController(root);
    const config = path.join(root, 'observer.yaml');
    const original = 'home: ./home\ndesktop:\n  refreshIntervalSeconds: 0.05\n';
    const started = (await control.start()).capture;
    assert.ok('pid' in started);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(config, 'home: [broken');
      await control.shutdown();
      assert.throws(() => process.kill(started.pid, 0));
    } finally {
      await writeFile(config, original);
      await control.shutdown();
    }
  });
});

await test('C7 桌面精简PATH且参考目录存在无效Node时，采集使用系统Node', async () => {
  await fixture(async (root) => {
    const referenceBin = path.join(root, 'nanobrowser/.build-env/node/bin');
    await mkdir(referenceBin, { recursive: true });
    await writeFile(path.join(referenceBin, 'node'), '#!/bin/sh\nexit 97\n', {
      mode: 0o755,
    });
    const previous = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const control = new CaptureController(root);
    try {
      await writeFile(
        path.join(root, 'src/scening/observe_activity.py'),
        'import json,os,subprocess\n' +
          'from scening.kmh_interpreter import KMHInterpreter\n' +
          'from scening.observer_config import load_config\n' +
          'from pathlib import Path\n' +
          'root=Path.cwd()\n' +
          "launcher=root/'probe.mjs'\n" +
          "launcher.write_text('console.log(JSON.stringify({node:process.version,argv:process.argv.slice(2)}));')\n" +
          "config=load_config(root/'observer.yaml').with_overrides(kmhLauncher=launcher)\n" +
          "result=KMHInterpreter(root/'home',config=config).run('desktop-node-probe')\n" +
          "print(json.dumps({'path':os.environ.get('PATH',''),'result':json.loads(result)}),flush=True)\n",
      );
      await control.start();
      await untilStopped(control);
      const output = await readFile(
        path.join(root, 'desktop/.cache/capture.log'),
        'utf8',
      );
      const probe = z
        .object({
          path: z.string(),
          result: z.object({ node: z.string(), argv: z.array(z.string()) }),
        })
        .parse(JSON.parse(output));
      assert.ok(
        probe.path
          .split(path.delimiter)
          .includes(path.join(os.homedir(), '.local/bin')),
      );
      assert.equal(
        probe.path.split(path.delimiter).includes(referenceBin),
        false,
      );
      assert.match(probe.result.node, /^v\d+\./);
      assert.equal(probe.result.argv.at(-1), 'desktop-node-probe');
    } finally {
      await control.shutdown();
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
});
