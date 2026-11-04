import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { SettingsService } from '../src/main/settings';
import { EditableConfigSchema } from '../src/shared/protocol';
import {
  settingFields,
  settingsDraft,
  settingsValue,
} from '../src/shared/settings';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function fixture(extension = 'yaml') {
  const temporary = await mkdtemp(path.join(root, 'tmp/settings-unit-'));
  const configPath = path.join(temporary, `observer.${extension}`);
  const original = await readFile(path.join(root, 'observer.yaml'), 'utf8');
  await writeFile(
    configPath,
    extension === 'json'
      ? JSON.stringify({
          ...parseDocument(original).toJS(),
          _comments: { source: '保留旧元数据' },
        })
      : original,
  );
  return {
    temporary,
    configPath,
    service: new SettingsService(root, configPath),
  };
}

await test('settings: YAML全部叶字段均进入表单，数值与路径往返保持，清空数值产生校验错误', async () => {
  const fixtureData = await fixture();
  try {
    const { config } = await fixtureData.service.read();
    const draft = settingsDraft(config);
    assert.deepEqual(
      Object.keys(draft).sort(),
      settingFields.map(([key]) => key).sort(),
    );
    assert.equal(
      new Set(settingFields.map(([key]) => key)).size,
      settingFields.length,
    );
    assert.deepEqual(
      EditableConfigSchema.parse(
        settingsValue(config, draft, config.taskTypes),
      ),
      config,
    );
    draft.captureCount = '';
    assert.equal(
      EditableConfigSchema.safeParse(
        settingsValue(config, draft, config.taskTypes),
      ).success,
      false,
    );
  } finally {
    await rm(fixtureData.temporary, { recursive: true, force: true });
  }
});

await test('settings: 统一保存全部分组与任务类型，保留注释和权限，重读版本一致', async () => {
  const { temporary, configPath, service } = await fixture();
  try {
    const original = await readFile(configPath, 'utf8');
    await chmod(configPath, 0o600);
    const snapshot = await service.read();
    const config = structuredClone(snapshot.config);
    config.scening.observationIntervalSeconds = 45;
    config.scening.captureFps = 4.5;
    config.sampleIntervalSeconds = 8;
    config.summaryIntervalSeconds = 1200;
    config.desktop.refreshIntervalSeconds = 3;
    config.home = './新目录/home';
    config.screenshotDir = './新目录/screens';
    config.taskTypes = ['学习', '研究'];
    config.analysis.jpegQuality = 82;
    config.dailyReview.maxChars = 700;
    config.control.pollSeconds = 0.02;
    const saved = await service.save({ ...snapshot, config });
    assert.deepEqual(saved.config, config);
    assert.deepEqual(await new SettingsService(root, configPath).read(), saved);
    assert.notEqual(snapshot.revision, saved.revision);
    const content = await readFile(configPath, 'utf8');
    for (const comment of original
      .split('\n')
      .filter((line) => line.trim().startsWith('#')))
      assert.ok(content.includes(comment), comment);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(temporary)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test('settings: 非法数字、路径、类型、未知字段及拼图跨字段校验均保留原文', async () => {
  const { temporary, configPath, service } = await fixture();
  try {
    const original = await readFile(configPath, 'utf8');
    const snapshot = await service.read();
    const invalid = [
      { ...snapshot.config, sampleIntervalSeconds: 0 },
      { ...snapshot.config, modelTimeoutSeconds: Number.POSITIVE_INFINITY },
      { ...snapshot.config, home: ' ' },
      { ...snapshot.config, screenshotDir: '' },
      { ...snapshot.config, kmhLauncher: '' },
      { ...snapshot.config, taskTypes: [] },
      { ...snapshot.config, taskTypes: ['工作', '工作'] },
      {
        ...snapshot.config,
        scening: { ...snapshot.config.scening, jpegQuality: 96 },
      },
      {
        ...snapshot.config,
        analysis: {
          ...snapshot.config.analysis,
          labelFontSize: snapshot.config.analysis.labelHeight + 1,
        },
      },
      {
        ...snapshot.config,
        analysis: { ...snapshot.config.analysis, maxImagePixels: 1 },
      },
      { ...snapshot.config, unknown: 1 },
    ];
    for (const config of invalid) {
      await assert.rejects(service.save({ ...snapshot, config }));
      assert.equal(await readFile(configPath, 'utf8'), original);
    }
    assert.deepEqual(await service.read(), snapshot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test('settings: 外部修改与连续旧版本保存报告冲突，重读可继续保存', async () => {
  const { temporary, configPath, service } = await fixture();
  try {
    const snapshot = await service.read();
    const external = `${await readFile(configPath, 'utf8')}\n# 外部更新\n`;
    await writeFile(configPath, external);
    await assert.rejects(service.save(snapshot), /配置已发生变化/);
    assert.equal(await readFile(configPath, 'utf8'), external);
    const current = await service.read();
    const request = {
      ...current,
      config: { ...current.config, summaryIntervalSeconds: 900 },
    };
    const results = await Promise.allSettled([
      service.save(request),
      service.save(request),
    ]);
    assert.equal(results[0]?.status, 'fulfilled');
    assert.equal(results[1]?.status, 'rejected');
    assert.equal((await service.read()).config.summaryIntervalSeconds, 900);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test('settings: 兼容旧配置默认策略块和 JSON 元数据，格式与元数据保持', async () => {
  const { temporary, configPath, service } = await fixture('json');
  try {
    const document = parseDocument(await readFile(configPath, 'utf8'));
    for (const key of [
      'desktop',
      'taskTypes',
      'control',
      'dailyReview',
      'scening',
      'analysis',
    ])
      document.delete(key);
    await writeFile(configPath, JSON.stringify(document.toJS()));
    const snapshot = await service.read();
    assert.equal(snapshot.config.desktop.refreshIntervalSeconds, 2);
    await service.save({
      ...snapshot,
      config: { ...snapshot.config, summaryIntervalSeconds: 700 },
    });
    const saved = EditableConfigSchema.safeParse(
      JSON.parse(await readFile(configPath, 'utf8')),
    );
    assert.equal(saved.success, false); // 兼容元数据由文件保留，表单协议只含编辑项。
    assert.match(await readFile(configPath, 'utf8'), /保留旧元数据/);
    assert.equal((await service.read()).config.summaryIntervalSeconds, 700);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test(
  'settings: 写入失败保留文件与版本，恢复权限后可重试',
  { skip: process.platform === 'win32' },
  async () => {
    const { temporary, configPath, service } = await fixture();
    try {
      const snapshot = await service.read();
      const original = await readFile(configPath, 'utf8');
      await chmod(temporary, 0o500);
      await assert.rejects(service.save(snapshot));
      assert.equal(await readFile(configPath, 'utf8'), original);
      await chmod(temporary, 0o700);
      await service.save(snapshot);
      assert.deepEqual((await service.read()).config, snapshot.config);
    } finally {
      await chmod(temporary, 0o700);
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

await test('每日时间：旧配置补齐、字符串草稿与真实保存', async () => {
  const { temporary, configPath, service } = await fixture();
  try {
    const document = parseDocument(await readFile(configPath, 'utf8'));
    document.set('dailyReview', { maxChars: 321 });
    await writeFile(configPath, document.toString());
    const original = await readFile(configPath, 'utf8');
    const snapshot = await service.read();
    assert.equal(snapshot.config.dailyReview.scheduledTime, '03:00');
    assert.equal(await readFile(configPath, 'utf8'), original);
    const draft = settingsDraft(snapshot.config);
    draft['dailyReview.scheduledTime'] = '04:15';
    const parsed = EditableConfigSchema.parse(
      settingsValue(snapshot.config, draft, snapshot.config.taskTypes),
    );
    assert.equal(parsed.dailyReview.scheduledTime, '04:15');
    await service.save({ ...snapshot, config: parsed });
    assert.equal(
      (await service.read()).config.dailyReview.scheduledTime,
      '04:15',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
