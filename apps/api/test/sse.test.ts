/**
 * SSE 端点测试
 *
 * 需要 Redis。连接不可用时跳过。
 *
 * 重点验证三件事：
 * 1. 订阅之后发布的事件能被推送（实时性）
 * 2. Last-Event-ID 能补发缺失区间（断点续传）
 * 3. 跨会话隔离 —— A 会话的订阅收不到 B 会话的事件
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '@svh/database';
import { loadEnvFile } from '@svh/config';

import { buildApp } from '../src/core/app.js';
import { closeEventPublisher, publishSessionEvent } from '../src/core/events.js';

// 必须在**模块作用域**加载 .env，不能放进 beforeAll。
//
// apps/api 的 vitest.config.ts 已配 setupFiles，理论上收集阶段就能读到环境变量；
// 但本文件的 `const canRun = (process.env.REDIS_URL ?? '').length > 0` 同样在收集阶段
// 求值，显式在这里加载可以消除对 setupFiles 执行顺序的隐式依赖 ——
// 与 Task 3 / Task 4 的写法保持一致。loadEnvFile 不覆盖已存在的变量，重复调用无副作用。
loadEnvFile(process.cwd());

let app: FastifyInstance;
let baseUrl: string;
let projectId: string;
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();
  // 只监听一次：Fastify 重复 listen 会抛 "Already listening"
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  const project = await prisma.project.create({
    data: { name: `SSE 测试项目 ${Date.now()}` },
    select: { id: true },
  });
  projectId = project.id;

  const a = await prisma.session.create({
    data: { projectId, title: 'A', agentState: 'idle' },
    select: { id: true },
  });
  const b = await prisma.session.create({
    data: { projectId, title: 'B', agentState: 'idle' },
    select: { id: true },
  });
  sessionA = a.id;
  sessionB = b.id;
});

afterAll(async () => {
  await closeEventPublisher();
  await prisma.project.deleteMany({ where: { id: projectId } });
  await app.close();
});

/**
 * 用原始 HTTP 读取 SSE 流。
 *
 * 不用 app.inject()：它会把响应缓冲到结束，而 SSE 是永不结束的流。
 */
async function openStream(
  sessionId: string,
  lastEventId?: string,
): Promise<{ frames: string[]; close: () => void }> {
  const controller = new AbortController();
  const frames: string[] = [];

  const response = await fetch(`${baseUrl}/api/agent/sessions/${sessionId}/events`, {
    headers: lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : {},
    signal: controller.signal,
  });
  expect(response.status).toBe(200);

  const reader = response.body?.getReader();
  void (async () => {
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // 主动关闭导致的读取中断是预期行为
    }
  })();

  return { frames, close: () => controller.abort() };
}

/** 等待条件成立 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 把累计的帧文本拼起来判断是否包含某个事件类型 */
function textOf(frames: string[]): string {
  return frames.join('');
}

const canRun = (process.env.REDIS_URL ?? '').length > 0;

describe.skipIf(!canRun)('SSE 端点', () => {
  it('会话不存在时返回 404 并说明是会话', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/agent/sessions/sess_not_exist/events',
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain('会话');
  });

  it('建连后立即下发 session.ready 与重连间隔', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    const text = textOf(frames);
    expect(text).toContain('retry:');
    expect(text).toContain('event: session.ready');
    close();
  });

  it('订阅之后发布的事件被实时推送', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionA, 'task.progress', { taskId: 'task_1', progress: 66 });

    await waitFor(() => textOf(frames).includes('task.progress'));
    expect(textOf(frames)).toContain('"progress":66');
    close();
  });

  it('Last-Event-ID 能补发缺失区间', async () => {
    // 先在无人订阅时发布两条事件
    const first = await publishSessionEvent(sessionA, 'agent.message', { n: 1 });
    await publishSessionEvent(sessionA, 'agent.message', { n: 2 });
    expect(first).not.toBeNull();

    const { frames, close } = await openStream(sessionA, first?.streamId);
    await waitFor(() => textOf(frames).includes('"n":2'));

    const text = textOf(frames);
    // 起点自身不应被补发，但起点之后的一条必须补发
    expect(text).toContain('"n":2');
    expect(text).not.toContain('"n":1');
    close();
  });

  /*
   * Last-Event-ID 是**外部可控输入**，必须校验后才允许进入订阅器。
   *
   * 不校验时，非法游标会让 XRANGE 与 XREAD 双双以命令级错误失败：订阅器连续
   * 3 次读取失败后结束订阅（不会死循环），但客户端看到的是「毫秒级建连又断开」。
   * 因此断言不能只停在 session.ready —— 那条帧在订阅开始**之前**就已写出，
   * 即使订阅当场死掉也能看到。必须再发一条事件，证明订阅真的活着。
   *
   * 取值刻意用 ASCII：HTTP 头是 ByteString，非 ASCII 字符在 fetch 层就被拒绝，
   * 根本到不了服务端（`fetch` 抛 "Cannot convert argument to a ByteString"）。
   */
  it('Last-Event-ID 非法时回退到基准游标，订阅照常收到后续事件', async () => {
    const { frames, close } = await openStream(sessionA, 'tampered-cursor');
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionA, 'task.progress', {
      taskId: 'task_bad_cursor',
      progress: 7,
    });
    await waitFor(() => textOf(frames).includes('task_bad_cursor'));

    expect(textOf(frames)).toContain('"progress":7');
    close();
  });

  it('跨会话隔离：A 的订阅收不到 B 的事件', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionB, 'agent.message', { secret: 'B 的内容' });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(textOf(frames)).not.toContain('B 的内容');
    close();
  });
});
