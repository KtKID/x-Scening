import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeControl } from '../src/main/runtime-control';
import {
  ControlRequestSchema,
  ControlReplySchema,
} from '../src/shared/scening.generated';

await test('C14 控制端提前断开一次，同请求幂等重送并保持总预算', async () => {
  const project = fileURLToPath(new URL('../..', import.meta.url));
  const home = await mkdtemp(path.join(project, 'tmp/control-reply-'));
  const requestIds: string[] = [];
  const server = createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (!input.includes('\n')) return;
      const raw: unknown = JSON.parse(input.trim());
      const request = ControlRequestSchema.parse(raw);
      requestIds.push(request.requestId);
      if (requestIds.length === 1) {
        socket.end();
        return;
      }
      const reply = ControlReplySchema.parse({
        requestId: request.requestId,
        pid: process.pid,
        state: 'running',
        analysisEnabled: false,
        epoch: 1,
        ok: true,
        message: '关闭已完成',
      });
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  try {
    server.listen(path.join(home, 'observer.sock'));
    await once(server, 'listening');
    const began = performance.now();
    const reply = await runtimeControl(
      home,
      process.pid,
      'disable-analysis',
      0.8,
    );
    assert.equal(reply.analysisEnabled, false);
    assert.equal(requestIds.length, 2);
    assert.equal(requestIds[0], requestIds[1]);
    assert.ok(performance.now() - began < 1000);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  }
});
