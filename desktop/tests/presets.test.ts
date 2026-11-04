import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PresetService } from '../src/main/presets';

const project = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const original =
  '# 保留原注释\nhome: ./personal\ncustom: "keep"\ntaskTypes:\n  - 工作\n  - 学习\n';

async function fixture(content = original, extension = 'yaml') {
  const root = await mkdtemp(path.join(project, 'tmp/type-presets-'));
  await writeFile(
    path.join(root, 'observer.yaml'),
    await readFile(path.join(project, 'observer.yaml'), 'utf8'),
  );
  const configPath = path.join(root, `custom.${extension}`);
  await writeFile(configPath, content);
  return { root, configPath, service: new PresetService(root, configPath) };
}

await test('presets: 保存增删后的列表，保留其他字段和中文注释并可重新读取', async () => {
  const { root, configPath, service } = await fixture();
  try {
    assert.deepEqual((await service.read()).taskTypes, ['工作', '学习']);
    await service.save({ taskTypes: ['学习', '研究'] });
    const saved = await readFile(configPath, 'utf8');
    assert.match(saved, /# 保留原注释/);
    assert.match(saved, /home: \.\/personal/);
    assert.match(saved, /custom: "keep"/);
    assert.deepEqual(
      (await new PresetService(root, configPath).read()).taskTypes,
      ['学习', '研究'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('presets: 旧配置缺项时读取项目YAML默认列表，读取保持文件原值', async () => {
  const content = '# 旧配置\nhome: ./personal\n';
  const { root, configPath, service } = await fixture(content);
  try {
    assert.deepEqual((await service.read()).taskTypes, [
      '工作',
      '学习',
      '娱乐',
      '游戏',
    ]);
    assert.equal(await readFile(configPath, 'utf8'), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('presets: 无效列表及越界字段被拒绝，原文件保持', async () => {
  const { root, configPath, service } = await fixture();
  try {
    for (const taskTypes of [
      [],
      [''],
      [' '],
      ['工作', '工作'],
      [' 工作'],
      ['工作\n学习'],
      ['工作\n'],
      [42],
      '工作',
    ]) {
      await assert.rejects(service.save({ taskTypes }));
      assert.equal(await readFile(configPath, 'utf8'), original);
    }
    await assert.rejects(
      service.save({ taskTypes: ['学习'], home: '/changed' }),
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('presets: JSON配置保存后保持JSON与其他值，连续请求顺序提交', async () => {
  const { root, configPath, service } = await fixture(
    JSON.stringify({ home: './personal', taskTypes: ['工作'], custom: 7 }),
    'json',
  );
  try {
    await Promise.all([
      service.save({ taskTypes: ['研究'] }),
      service.save({ taskTypes: ['研究', '写作'] }),
    ]);
    const saved: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(saved, {
      home: './personal',
      taskTypes: ['研究', '写作'],
      custom: 7,
    });
    assert.equal(
      (await readdir(root)).some((name) =>
        name.startsWith('.observer-presets-'),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('presets: 重复配置键和非映射配置给出错误，文件保持', async () => {
  const { root, configPath, service } = await fixture();
  try {
    for (const content of [
      'taskTypes: [工作]\ntaskTypes: [学习]\n',
      '- 工作\n- 学习\n',
    ]) {
      await writeFile(configPath, content);
      await assert.rejects(service.read());
      await assert.rejects(service.save({ taskTypes: ['研究'] }));
      assert.equal(await readFile(configPath, 'utf8'), content);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test(
  'presets: 写入失败保留原配置，恢复后可重试保存',
  { skip: process.platform === 'win32' },
  async () => {
    const { root, configPath, service } = await fixture();
    try {
      await chmod(root, 0o500);
      await assert.rejects(service.save({ taskTypes: ['研究'] }));
      assert.equal(await readFile(configPath, 'utf8'), original);
      await chmod(root, 0o700);
      await service.save({ taskTypes: ['研究'] });
      assert.deepEqual((await service.read()).taskTypes, ['研究']);
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);
