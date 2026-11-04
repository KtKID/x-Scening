import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { z } from 'zod';
import {
  ControlRequestSchema,
  ControlReplySchema,
} from '../shared/scening.generated';

type Action = z.infer<typeof ControlRequestSchema>['action'];
type Request = z.infer<typeof ControlRequestSchema>;
type Reply = z.infer<typeof ControlReplySchema>;
class IncompleteReply extends Error {}

/** 每条连接处理一条请求；截止时间覆盖连接、传输、取消和真实完成回执。 */
export async function runtimeControl(
  home: string,
  pid: number,
  action: Action,
  timeoutSeconds: number,
): Promise<Reply> {
  const request = ControlRequestSchema.parse({
    requestId: randomUUID(),
    pid,
    action,
  });
  const deadline = performance.now() + timeoutSeconds * 1000;
  try {
    return await exchange(home, request, timeoutSeconds);
  } catch (error) {
    if (!(error instanceof IncompleteReply)) throw error;
    // 四个动作均为幂等目标状态；无完整回执时以同请求重送一次，共用原截止时间。
    const remaining = Math.max(0, (deadline - performance.now()) / 1000);
    if (remaining <= 0) throw new Error('采集控制等待超时，请查看项目logs');
    return exchange(home, request, remaining);
  }
}

function exchange(
  home: string,
  request: Request,
  timeoutSeconds: number,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path.join(home, 'observer.sock'));
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, reply?: Reply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (reply) resolve(reply);
    };
    const timer = setTimeout(
      () => finish(new Error('采集控制等待超时，请查看项目logs')),
      timeoutSeconds * 1000,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('error', (error) => finish(error));
    socket.on('end', () =>
      finish(new IncompleteReply('采集控制连接已结束，请刷新状态')),
    );
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 65536) {
        finish(new Error('采集控制响应过长'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const raw: unknown = JSON.parse(buffer.slice(0, end));
        const reply = ControlReplySchema.parse(raw);
        if (reply.pid !== request.pid || reply.requestId !== request.requestId)
          throw new Error('采集控制回执身份不符');
        if (!reply.ok) throw new Error(reply.message);
        finish(undefined, reply);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('采集控制响应无效'));
      }
    });
  });
}
