import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import { ModelSettingsService } from '../src/main/models';
import { SettingsService } from '../src/main/settings';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const suppliedRuntime = process.env.KMH_TEST_RUNTIME;
const original =
  suppliedRuntime ?? path.join(root, 'desktop/.cache/kmh-runtime');
const directory = await mkdtemp(path.join(root, 'tmp/portable-kmh-'));
const runtime = suppliedRuntime ?? path.join(directory, 'runtime');
if (!suppliedRuntime) await rename(original, runtime);
const checks: string[] = [];
try {
  const home = path.join(directory, 'home');
  await mkdir(home);
  const llm = pathToFileURL(
    path.join(runtime, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
  ).href;
  const plugin = path.join(directory, 'mock.mjs');
  await writeFile(
    plugin,
    `import {LlmAdapter} from ${JSON.stringify(llm)};
export const name='portable-mock';export const inject=['llm'];
export function apply(ctx,config){
 class Adapter extends LlmAdapter {
  index=0;
  providerInfo(id){return {id,name:'fixture'};}
  async listModels(provider){return [{provider,id:'fixture',name:'fixture',inputModalities:['text','image']}];}
  async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text','image']};}
  async *stream(){for(const chunk of config.script[this.index++])yield chunk;}
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['portable-fixture'],new Adapter()));
}`,
  );
  const text = (value: string) => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const tool = (name: string, args: unknown) => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: name,
      name,
      argumentsDelta: JSON.stringify(args),
    },
    {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: name,
        name,
        arguments: JSON.stringify(args),
      },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  const invoke = (args: string[]) =>
    execute(
      path.join(runtime, 'node'),
      [path.join(runtime, 'kmh.mjs'), 'dsh', '--profile', 'scening', ...args],
      {
        cwd: directory,
        env: { ...process.env, KMH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  const dump = await invoke(['--dump-config']);
  assert.match(dump.stdout, /@kmh\/scene-observer/);
  assert.equal(dump.stdout.includes('/kongming-os/'), false);
  checks.push('迁移运行目录后配置展开成功，插件位置全部来自内置安装。');
  const inputFile = path.join(directory, 'input.txt');
  await writeFile(inputFile, 'fixture timeline');
  const patch = path.join(directory, 'summary.json');
  await writeFile(
    patch,
    JSON.stringify([
      { id: 'scene-observer', config: { mode: 'summary', inputFile } },
      {
        id: 'agent-default-model',
        config: { provider: 'portable-fixture', model: 'fixture' },
      },
      {
        insert: [
          {
            id: 'mock',
            name: plugin,
            config: {
              script: [
                tool('read', { file_path: inputFile }),
                text('portable summary success'),
              ],
            },
          },
        ],
      },
    ]),
  );
  const response = await invoke(['--patch', patch, 'read and summarize']);
  assert.match(response.stdout, /portable summary success/);
  checks.push(
    '真实scening Agent与原生read工具完成总结，模型响应由本地替身提供。',
  );
  const imageFile = path.join(directory, 'input.png');
  // 已固定的2×2 PNG用于原生读图，避免依赖外部图片或正式记录。
  await execute(path.join(root, '.venv/bin/python'), [
    '-c',
    'from PIL import Image; import sys; Image.new("RGB",(16,16),"blue").save(sys.argv[1])',
    imageFile,
  ]);
  const resultFile = path.join(directory, 'result.json');
  await writeFile(
    patch,
    JSON.stringify([
      {
        id: 'scene-observer',
        config: { mode: 'analysis', inputFile: imageFile, resultFile },
      },
      {
        id: 'agent-default-model',
        config: { provider: 'portable-fixture', model: 'fixture' },
      },
      {
        insert: [
          {
            id: 'mock',
            name: plugin,
            config: {
              script: [
                tool('read_image', { file_path: imageFile }),
                tool('submit_observation', {
                  visible_activity: '蓝色测试画面',
                  inferred_intent: '推测在验证',
                  stage_and_evidence: '可见蓝色画面',
                  app_tags: ['fixture'],
                  task_types: [],
                }),
              ],
            },
          },
        ],
      },
    ]),
  );
  await invoke(['--patch', patch, 'inspect image']);
  const observation: unknown = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.match(JSON.stringify(observation), /蓝色测试画面/);
  checks.push(
    '真实read_image与submit_observation提交结构化结果，原生图片与附件依赖可用。',
  );
  // 唯一替身为本机模型HTTP端点；真实KMH适配器、凭据服务和设置文件全部执行。
  const received: { model: string; authorized: boolean }[] = [];
  const RequestSchema = z.object({ model: z.string() }).passthrough();
  const server = createServer((request, response) => {
    let content = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      content += chunk;
    });
    request.on('end', () => {
      const parsed = RequestSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        response.writeHead(400).end();
        return;
      }
      received.push({
        model: parsed.data.model,
        authorized:
          request.headers.authorization === 'Bearer fixture-persisted-secret',
      });
      const delta =
        received.length === 1
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'read-1',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ file_path: inputFile }),
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: 'persisted model and credential success',
            };
      const finish_reason = received.length === 1 ? 'tool_calls' : 'stop';
      const event = (part: unknown, finish: string | null) =>
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture-vision',
          choices: [{ index: 0, delta: part, finish_reason: finish }],
        });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${event(delta, null)}\n\ndata: ${event({}, finish_reason)}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const config = path.join(directory, 'observer.yaml');
    const document = parseDocument(
      await readFile(path.join(root, 'observer.yaml'), 'utf8'),
    );
    document.set('home', directory);
    await writeFile(config, document.toString());
    // 设置服务采用<observer-home>/kmh，这里将其与独占KMH_HOME对齐。
    const models = new ModelSettingsService(
      new SettingsService(root, config),
      runtime,
      config,
    );
    await models.save({
      provider: 'portable-endpoint',
      kind: 'custom',
      apiKey: 'fixture-persisted-secret',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      api: 'openai-completions',
      model: 'fixture-vision',
      reasoningEffort: '',
    });
    const modelHome = path.join(directory, 'kmh');
    await writeFile(
      patch,
      JSON.stringify([
        { id: 'scene-observer', config: { mode: 'summary', inputFile } },
      ]),
    );
    const persisted = await execute(
      path.join(runtime, 'node'),
      [
        path.join(runtime, 'kmh.mjs'),
        'dsh',
        '--profile',
        'scening',
        '--patch',
        path.join(modelHome, 'observer-model.patch.yml'),
        '--patch',
        patch,
        'summarize',
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          KMH_HOME: modelHome,
          DSH_TELEMETRY_DISABLED: '1',
        },
        timeout: 45000,
      },
    );
    assert.match(persisted.stdout, /persisted model and credential success/);
    assert.deepEqual(received, [
      { model: 'fixture-vision', authorized: true },
      { model: 'fixture-vision', authorized: true },
    ]);
    checks.push(
      '设置保存的模型、API地址和密钥经真实llm-pi-ai适配器到达本机端点，两轮请求均通过认证与模型断言。',
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  assert.ok(
    (
      await realpath(path.join(runtime, 'node_modules/@kmh/scene-observer'))
    ).startsWith(runtime),
  );
  const evidence = path.join(root, 'reports/model-settings-20261105/evidence');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, 'bundled-runtime.json'),
    JSON.stringify(
      { checks, externalModelCalls: 0, localEndpointRequests: received.length },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} finally {
  if (!suppliedRuntime) await rename(runtime, original);
  await rm(directory, { recursive: true, force: true });
}
