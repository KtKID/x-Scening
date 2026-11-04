import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { demoSnapshot, TEST_PREFIX } from '../src/shared/demo';
import { DaySchema, QuerySchema } from '../src/shared/protocol';
import { readLocalDay, readSnapshotImage } from '../src/main/data';
import { cardPreview } from '../src/shared/presentation';

const day = '2026-10-27';
const record = {
  start: `${day}T09:00:00+08:00`,
  end: `${day}T09:30:00+08:00`,
  app: 'Code',
  analysis: '真实协议测试夹具',
  screenshot: 'images/one.png',
  mini: 'images/one.png',
  source: 'screen',
};
const summary = {
  windowStart: `${day}T09:00:00+08:00`,
  windowEnd: `${day}T10:00:00+08:00`,
  generatedAt: `${day}T10:01:00+08:00`,
  timeline: [record],
  gaps: [],
  summary: '窗口总结',
  trigger: 'periodic',
};

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const directory = path.resolve(import.meta.dirname, '../../tmp');
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'observer-unit-'));
  try {
    await mkdir(path.join(root, 'home/records'), { recursive: true });
    await mkdir(path.join(root, 'home/summaries'), { recursive: true });
    await mkdir(path.join(root, 'home/images'), { recursive: true });
    await writeFile(
      path.join(root, 'observer.yaml'),
      'home: ./home\nscreenshotDir: ./snapshots\nsampleIntervalSeconds: 5\nscening:\n  captureFps: 5\n',
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test('T1 所有日期的虚拟卡片与总结以测试标记开头', () => {
  for (const date of [day, '2026-01-01', '2028-02-29']) {
    const snapshot = demoSnapshot(date);
    assert.equal(snapshot.activities.length, 5);
    assert.equal(snapshot.source, 'demo');
    for (const item of snapshot.activities) {
      assert.ok(item.title.startsWith(TEST_PREFIX));
      assert.ok(item.analysis.startsWith(TEST_PREFIX));
      assert.ok(item.start.startsWith(date));
    }
    assert.ok(
      snapshot.summaries.every((item) => item.summary.startsWith(TEST_PREFIX)),
    );
  }
});

await test('T8 Python三帧记录可由客户端只读加载并读取真实JPEG拼图', async () => {
  await fixture(async (root) => {
    const project = path.resolve(import.meta.dirname, '../..');
    const result = spawnSync(
      path.join(project, '.venv/bin/python'),
      [
        '-B',
        '-c',
        `import sys
from pathlib import Path
from datetime import datetime,timedelta
from PIL import Image
from scening.capture import Display,Frame
from scening.frame_store import FrameStore,Candidate
from scening.observe_activity import ActivityPipeline
from scening.observation_generated import ObservationResult
from scening.observer_config import load_config
from scening import runtime_logging
root=Path(sys.argv[1]);home=root/'home'
runtime_logging.LOG_PATH=root/'events.log'
config=load_config().with_overrides(home=home,screenshotDir=root/'snapshots')
class Model:
    def analyze(self,image,frames=None):
        return ObservationResult(schema_version=1,visible_activity='检查项目。',inferred_intent='推测在核对配置。',stage_and_evidence='完成状态待确认。',app_tags=['Code','Observer'],task_types=['工作','学习'])
pipeline=ActivityPipeline(home,Model(),config)
store=FrameStore(config.screenshotDir,config.scening.jpegQuality)
try:
    for index,color in enumerate(['red','green','blue']):
        at=datetime.fromisoformat('2026-10-27T09:00:00+08:00')+timedelta(seconds=index*20)
        with Image.new('RGB',(300,200),color) as image:
            saved=store.save(Frame(image,at,Display(1,0,0,300,200),'Code','code'),'test',temporary=False)
        pipeline.process(Candidate(saved,'test').prepared,at,'Code','code',screen=1)
finally:store.close()
`,
        root,
      ],
      {
        cwd: project,
        env: { ...process.env, PYTHONPATH: path.join(project, 'src') },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(root, `home/records/${day}.json`);
    const before = await readFile(target, 'utf8');
    const snapshot = await readLocalDay(root, day);
    assert.deepEqual(snapshot.issues, []);
    const activity = snapshot.activities[0];
    assert.ok(activity);
    assert.equal(activity.frames?.length, 3);
    assert.equal(activity.end, `${day}T09:00:40+08:00`);
    assert.deepEqual(activity.observation?.app_tags, ['Code', 'Observer']);
    assert.deepEqual(activity.observation?.task_types, ['工作', '学习']);
    assert.equal(activity.observation?.schema_version, 1);
    assert.equal(cardPreview(activity.analysis), '检查项目。');
    assert.ok(activity.analysis.includes('完成状态待确认。'));
    assert.ok(activity.screenshot.startsWith('analysis/'));
    const image = await readSnapshotImage(snapshot, activity.id);
    assert.equal(image.status, 'ready');
    if (image.status === 'ready')
      assert.ok(image.dataUrl.startsWith('data:image/jpeg;base64,'));
    assert.equal(await readFile(target, 'utf8'), before);
  });
});

await test('T2 真实协议活动和总结只读读取，未知扩展字段保留', async () => {
  await fixture(async (root) => {
    const target = path.join(root, `home/records/${day}.json`);
    const content = JSON.stringify([{ ...record, custom: '保留' }]);
    await writeFile(target, content);
    await writeFile(
      path.join(root, `home/summaries/${day}.json`),
      JSON.stringify([summary]),
    );
    const result = await readLocalDay(root, day);
    assert.equal(result.activities[0]?.analysis, record.analysis);
    assert.equal(result.activities[0]?.custom, '保留');
    assert.equal(result.summaries[0]?.summary, '窗口总结');
    assert.deepEqual(result.issues, []);
    assert.equal(await readFile(target, 'utf8'), content);
  });
});

await test('T3 缺文件为空，坏活动仍保留有效总结，非法区间和错日明确报错', async () => {
  await fixture(async (root) => {
    assert.equal((await readLocalDay(root, day)).activities.length, 0);
    const target = path.join(root, `home/records/${day}.json`);
    await writeFile(target, '{broken');
    await writeFile(
      path.join(root, `home/summaries/${day}.json`),
      JSON.stringify([summary]),
    );
    const broken = await readLocalDay(root, day);
    assert.equal(broken.summaries.length, 1);
    assert.ok(broken.issues.some((issue) => issue.includes('活动')));
    for (const bad of [
      { ...record, end: `${day}T08:00:00+08:00` },
      { ...record, start: '2026-10-26T09:00:00+08:00' },
      { ...record, analysis: '  ' },
      { ...record, observation: { schema_version: 2 } },
    ]) {
      await writeFile(target, JSON.stringify([bad]));
      const invalid = await readLocalDay(root, day);
      assert.equal(invalid.activities.length, 0);
      assert.ok(invalid.issues.length > 0);
    }
    await writeFile(target, JSON.stringify([record]));
    await writeFile(path.join(root, `home/summaries/${day}.json`), '{broken');
    const summaryFailure = await readLocalDay(root, day);
    assert.equal(summaryFailure.activities.length, 1);
    assert.ok(summaryFailure.issues.some((issue) => issue.includes('总结')));
    for (const invalidConfig of [
      'home: ./home\nhome: ./other',
      'home: ""',
      'home: [',
    ]) {
      await writeFile(path.join(root, 'observer.yaml'), invalidConfig);
      const result = await readLocalDay(root, day);
      assert.equal(result.activities.length, 0);
      assert.ok(result.issues.some((issue) => issue.includes('配置读取失败')));
    }
    await rm(path.join(root, 'observer.yaml'));
    assert.ok(
      (await readLocalDay(root, day)).issues.some((issue) =>
        issue.includes('配置读取失败'),
      ),
    );
  });
});

await test('T4 图片按已加载ID读取，相对和绝对引用可用，越界和缺图明确处理', async () => {
  await fixture(async (root) => {
    const image = path.join(root, 'home/images/one.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8f28rAzbAhFV00EoAAPfdApLUYjL3AAAAAElFTkSuQmCC',
      'base64',
    );
    await writeFile(image, png);
    const target = path.join(root, `home/records/${day}.json`);
    const external = path.join(root, 'historical/one.png');
    await mkdir(path.dirname(external), { recursive: true });
    await writeFile(external, png);
    for (const reference of ['images/one.png', image, external]) {
      await writeFile(
        target,
        JSON.stringify([{ ...record, screenshot: reference }]),
      );
      const snapshot = await readLocalDay(root, day);
      const item = snapshot.activities[0];
      assert.ok(item);
      assert.equal(
        (await readSnapshotImage(snapshot, item.id)).status,
        'ready',
      );
      assert.equal(
        (await readSnapshotImage(snapshot, '/etc/passwd')).status,
        'missing',
      );
    }
    await writeFile(
      target,
      JSON.stringify([{ ...record, screenshot: '../private.png' }]),
    );
    const unsafe = await readLocalDay(root, day);
    const unsafeItem = unsafe.activities[0];
    assert.ok(unsafeItem);
    assert.equal(
      (await readSnapshotImage(unsafe, unsafeItem.id)).status,
      'missing',
    );
    await rm(image);
    await writeFile(target, JSON.stringify([record]));
    const missing = await readLocalDay(root, day);
    assert.equal(
      (await readSnapshotImage(missing, missing.activities[0]?.id ?? ''))
        .status,
      'missing',
    );
  });
});

await test('T10 日期校验拒绝穿越、非法日与非法来源', () => {
  for (const bad of ['../../etc', '2026-02-30', '2026-13-01', '2026-2-2'])
    assert.equal(DaySchema.safeParse(bad).success, false);
  assert.equal(
    QuerySchema.safeParse({ day, source: 'unknown' }).success,
    false,
  );
});

await test('T11 四字段文字总结和旧图片引用总结可同时读取', async () => {
  await fixture(async (root) => {
    const textEvent = {
      start: record.start,
      end: record.end,
      app: record.app,
      analysis: record.analysis,
    };
    const current = {
      ...summary,
      generatedAt: `${day}T10:02:00+08:00`,
      timeline: [textEvent],
      summary: '新版文字时间表总结',
    };
    const target = path.join(root, `home/summaries/${day}.json`);
    const original = JSON.stringify([summary, current]);
    await writeFile(target, original);
    const snapshot = await readLocalDay(root, day);
    assert.deepEqual(snapshot.issues, []);
    assert.equal(snapshot.summaries.length, 2);
    assert.equal(
      snapshot.summaries[0]?.timeline[0]?.screenshot,
      record.screenshot,
    );
    assert.deepEqual(snapshot.summaries[1]?.timeline, [textEvent]);
    assert.equal(await readFile(target, 'utf8'), original);
  });
});
