/**
 * Agent 轮次事件发布链路测试（Task 6）
 *
 * 守住的是「路由 → 事件总线 → Redis Stream」这条**接线**：
 * 断言事件真的落进了对应会话的 Stream，而不是重复验证发布器内部实现
 * （发布器的行为已由 @svh/realtime 自己的测试覆盖）。
 *
 * 需要 Redis。未配置 REDIS_URL 时整组跳过 —— 与 @svh/queue、@svh/realtime
 * 的约定一致。
 *
 * ── 为什么 REDIS_URL 必须在模块作用域读取 ──
 * `describe.skipIf` 在**收集阶段**求值，早于任何 beforeAll；若把读取推迟到
 * 钩子里，判断永远拿到空串，整组用例会被静默跳过 —— 测试全绿但什么都没验证。
 * `.env` 已由 vitest setupFiles（test/setup-env.ts）在任何 import 之前加载。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getEnv } from '@svh/config';
import { disconnectPrisma, prisma } from '@svh/database';
import { parseRedisConnection } from '@svh/queue';
import { createEventStream, type StreamedEvent } from '@svh/realtime';

import { buildApp } from '../src/core/app.js';
import { closeEventPublisher, publishSessionEvent } from '../src/core/events.js';
import { closeQueuePool } from '../src/core/tasks.js';

import type { FastifyInstance } from 'fastify';

const redisUrl = process.env.REDIS_URL ?? '';
const canRun = redisUrl.length > 0;

let app: FastifyInstance;
let projectId: string;

beforeAll(async () => {
  // .env 已由 setupFiles 加载，这里只装配应用
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: `Task6 事件链路验证项目 ${Date.now()}` },
  });
  projectId = (res.json() as { id: string }).id;
});

afterAll(async () => {
  await app.close();
  // 发布器与队列池都是进程内单例，必须释放，否则测试进程挂着不退
  await closeEventPublisher();
  await closeQueuePool();
  await disconnectPrisma();
});

/**
 * 读取某个会话的完整事件流。
 *
 * 用 `@svh/realtime` 的订阅器（SSE 端点的同一条消费路径）读取，
 * 而不是直连 ioredis —— 后者不是 apps/api 的依赖。
 */
async function collectEvents(sessionId: string, expected: number): Promise<StreamedEvent[]> {
  const stream = createEventStream({ connection: parseRedisConnection(getEnv().REDIS_URL) });
  const controller = new AbortController();
  const deadline = Date.now() + 5_000;
  const events: StreamedEvent[] = [];

  for await (const message of stream.subscribe({
    sessionId,
    afterId: '0-0',
    blockMs: 100,
    signal: controller.signal,
  })) {
    if (message.kind === 'event') events.push(message.event);
    // 收齐即退出；退出会触发生成器的 finally 断开连接，无需再 abort
    if (events.length >= expected || Date.now() > deadline) break;
  }

  return events;
}

describe.skipIf(!canRun)('Agent 轮次事件发布', () => {
  it('sessionId 为空时直接跳过，不报错也不发布', async () => {
    await expect(publishSessionEvent(null, 'agent.state', { state: 'thinking' })).resolves.toBeNull();
    await expect(publishSessionEvent('', 'agent.state', { state: 'thinking' })).resolves.toBeNull();
    await expect(
      publishSessionEvent(undefined, 'agent.state', { state: 'thinking' }),
    ).resolves.toBeNull();
  });

  it('POST /api/agent/chat 把轮次事件写入会话 Stream', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId, message: '帮我做一个 30 秒广告' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { sessionId: string; payload?: { type: string } };
    // 固定 4 条：开始状态、结束状态、文本消息、载荷映射事件
    const events = await collectEvents(body.sessionId, 4);

    expect(events).toHaveLength(4);
    expect(events.map((e) => e.type)).toEqual([
      'agent.state',
      'agent.state',
      'agent.message',
      body.payload?.type === 'plan' ? 'agent.plan' : 'agent.message',
    ]);

    // 开始广播必须先于模型返回：前端的「思考中」不能等模型跑完才出现
    expect(events[0]?.data).toEqual({ state: 'thinking' });

    // seq 会话内单调递增，SSE 断线续传依赖该契约
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('POST /api/agent/sessions/:id/confirm 广播 task.status', async () => {
    // 直接落一条 waiting_user 任务：确认接口需要真实对象才能放行
    const session = await prisma.session.create({
      data: { projectId, title: 'Task6 确认放行验证', agentState: 'waiting_user' },
      select: { id: true },
    });
    const task = await prisma.agentTask.create({
      data: {
        projectId,
        sessionId: session.id,
        skillId: 'video.generate',
        queueName: 'ai_video',
        risk: 'high',
        status: 'waiting_user',
        input: {},
      },
      select: { id: true },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/sessions/${session.id}/confirm`,
      payload: { taskIds: [task.id] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { resumed: string[] }).resumed).toEqual([task.id]);

    const events = await collectEvents(session.id, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task.status');
    expect(events[0]?.data).toEqual({ taskId: task.id, status: 'pending' });
  });
});
