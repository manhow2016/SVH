/**
 * Agent 轮次事件发布链路测试（Task 6）
 *
 * 守住的是「路由 → 事件总线 → Redis Stream」这条**接线**：
 * 断言事件真的落进了对应会话的 Stream，而不是重复验证发布器内部实现
 * （发布器的行为已由 @svh/realtime 自己的测试覆盖）。
 *
 * ── 分组规则 ──
 * 「sessionId 为空直接跳过」「发布超时上界」「发布器不可用时取消照常生效」
 * 这类**不需要 Redis** 的用例一律放在**不加 gate** 的分组里，只有真正需要
 * Redis / 数据库的接线用例才进 `describe.skipIf(!canRun)`。把不需要外部服务的
 * 用例混进被 gate 的分组，会让「发布失败不影响业务」这条全任务最核心的约定
 * 在没有 Redis 的机器上被静默跳过 —— 测试全绿但什么都没验证
 * （仓库里已经因为同一个模式修过三次）。
 *
 * ── 为什么 REDIS_URL 必须在模块作用域读取 ──
 * `describe.skipIf` 在**收集阶段**求值，早于任何 beforeAll；若把读取推迟到
 * 钩子里，判断永远拿到空串，整组用例会被静默跳过 —— 测试全绿但什么都没验证。
 * `.env` 已由 vitest setupFiles（test/setup-env.ts）在任何 import 之前加载。
 */
import { createServer, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { __setEnvForTesting, getEnv, parseEnv } from '@svh/config';
import { disconnectPrisma, prisma } from '@svh/database';
import { parseRedisConnection } from '@svh/queue';
import { createEventStream, type StreamedEvent } from '@svh/realtime';

import { buildApp } from '../src/core/app.js';
import { closeEventPublisher, publishSessionEvent } from '../src/core/events.js';
import { closeQueuePool } from '../src/core/tasks.js';

import type { FastifyInstance } from 'fastify';

const redisUrl = process.env.REDIS_URL ?? '';
const canRun = redisUrl.length > 0;

/**
 * 读取某个会话的完整事件流。
 *
 * 用 `@svh/realtime` 的订阅器（SSE 端点的同一条消费路径）读取，
 * 而不是直连 ioredis —— 后者不是 apps/api 的依赖。
 */
async function collectEvents(
  sessionId: string,
  expected: number,
  deadlineMs = 5_000,
): Promise<StreamedEvent[]> {
  const stream = createEventStream({ connection: parseRedisConnection(getEnv().REDIS_URL) });
  const controller = new AbortController();
  const deadline = Date.now() + deadlineMs;
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

/** 假 Redis 服务句柄 */
interface FakeRedisServer {
  port: number;
  /** 已 accept 的连接，用来证明「TCP 确实建立了」 */
  sockets: Socket[];
  close: () => Promise<void>;
}

/** 极简 RESP 应答：够 ioredis 完成握手与 incr/xadd/expire 即可 */
function replyForCommand(name: string): string {
  const bulk = (text: string): string => `$${String(Buffer.byteLength(text))}\r\n${text}\r\n`;
  switch (name) {
    case 'info':
      return bulk('# Server\r\nredis_version:7.0.0\r\n');
    case 'incr':
      return ':1\r\n';
    case 'xadd':
      return bulk('1-1');
    case 'expire':
      return ':1\r\n';
    default:
      return '+OK\r\n';
  }
}

/**
 * 起一个假的 Redis TCP 服务，用来稳定构造真实的故障形态。
 *
 * `replyDelay(command)` 返回该命令的应答延迟（毫秒）；返回 null 表示永不回包。
 * 于是可以精确拼出两种形态：
 * - 全部返回 null：只 accept、从不回包（半开 TCP / Redis 被 STOP / 网络分区）
 * - 前面命令快、后面命令慢：单命令都不超时，但串行叠加超过上界
 */
async function startFakeRedis(
  replyDelay: (command: string) => number | null,
): Promise<FakeRedisServer> {
  const sockets: Socket[] = [];
  let closing = false;

  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    if (closing) {
      // 收尾阶段的迟到重连直接掐掉，避免 server.close() 一直等下去
      socket.destroy();
      return;
    }
    socket.on('data', (chunk: Buffer) => {
      // 一条 TCP 包里可能挤着多条命令（ioredis 的握手与离线队列冲刷）
      for (const part of chunk.toString('utf8').split(/(?=\*\d+\r\n)/)) {
        const name = /^\*\d+\r\n\$\d+\r\n([^\r\n]+)\r\n/.exec(part)?.[1]?.toLowerCase();
        if (name === undefined) continue;
        const delayMs = replyDelay(name);
        if (delayMs === null) continue;
        const reply = replyForCommand(name);
        setTimeout(() => {
          if (!socket.destroyed) socket.write(reply);
        }, delayMs);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('未拿到监听端口');

  return {
    port: address.port,
    sockets,
    close: async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe.skipIf(!canRun)('Agent 轮次事件发布', () => {
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

  /*
   * 取消是 Worker 之外**唯一**的任务状态写入点。修复前它只写库、不发声：
   * 正在通过 SSE 跟踪该任务的前端会一直停在 running，直到用户自己刷新。
   * 取消恰恰是前端必然会有的按钮，留着不通等于交付一个已知缺口。
   */
  it('POST /api/tasks/:id/cancel 广播 task.status: cancelled', async () => {
    // 运行中的任务：这正是用户点「取消」时库里的状态
    const session = await prisma.session.create({
      data: { projectId, title: '取消广播验证' },
      select: { id: true },
    });
    const task = await prisma.agentTask.create({
      data: {
        projectId,
        sessionId: session.id,
        skillId: 'asset.create',
        queueName: 'asset',
        status: 'running',
        input: {},
      },
      select: { id: true },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/cancel`,
      payload: { reason: '用户取消' },
    });
    expect(res.statusCode).toBe(204);

    // 事件必须在响应返回前就落进会话流，前端无需刷新即可看到终态
    const events = await collectEvents(session.id, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task.status');
    expect(events[0]?.data).toEqual({
      taskId: task.id,
      status: 'cancelled',
      message: '用户取消',
    });

    // 事件里的状态必须与数据库一致，否则前端刷新后会出现状态跳变
    const stored = await prisma.agentTask.findUnique({
      where: { id: task.id },
      select: { status: true },
    });
    expect(stored?.status).toBe('cancelled');
  });

  /*
   * 载荷为空时第三条发布必须**跳过**。
   *
   * 旧实现把 `undefined` 送进 eventTypeForPayload 的默认分支，于是这一轮出现
   * 两条 agent.message：一条是真正的文本消息，另一条 data 为 null。
   * 事件流的形状就是后续 SSE 前端的契约 —— 按「agent.message 即追加消息」
   * 实现的前端会渲染出一条空消息。
   */
  it('轮次没有结构化载荷时不额外推送空的 agent.message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId, message: '你好' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      sessionId: string;
      message: string;
      state: string;
      payload?: unknown;
    };
    // 先确认这条路径确实「没有载荷」，否则本用例证明不了任何事
    expect(body.payload).toBeUndefined();

    /*
     * 故意要 4 条：发布发生在响应返回之前，流里的事件已经齐了。
     * 旧实现会凑满 4 条，新实现只有 3 条 —— 读到静默窗口结束为止。
     */
    const events = await collectEvents(body.sessionId, 4, 800);
    expect(events.map((e) => e.type)).toEqual([
      'agent.state',
      'agent.state',
      'agent.message',
    ]);
    expect(events[2]?.data).toEqual({ message: body.message, state: body.state });
  });

  /*
   * 「发布失败不影响业务」是本任务存在的理由，必须有自动化护栏。
   *
   * 用非法 REDIS_URL 制造「发布器**构造期**就抛错」：`redis://[]` 能通过
   * @svh/config 的前缀校验（只要求 redis:// 开头），但会让 parseRedisConnection
   * 里的 `new URL` 抛 TypeError。这条路径正是只靠 `publish` 返回 null 兜不住的
   * 那一半 —— 删掉 events.ts 的 try/catch，本用例立刻变红。
   */
  it('发布器不可用时（REDIS_URL 非法）发布返回 null，且 /chat 仍返回 200', async () => {
    const healthyEnv = getEnv();
    // 单例可能已被前一个用例建好，先关掉，确保下一次 getEventPublisher() 重新构造
    await closeEventPublisher();
    __setEnvForTesting({ ...healthyEnv, REDIS_URL: 'redis://[]' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        publishSessionEvent('task6-bad-redis', 'agent.state', { state: 'thinking' }),
      ).resolves.toBeNull();
      // 确实是走到了「发布器不可用」的兜底分支，而不是恰好没触发发布
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('事件发布器不可用')),
      ).toBe(true);

      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/chat',
        payload: { projectId, message: '你好' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      warnSpy.mockRestore();
      __setEnvForTesting(healthyEnv);
      await closeEventPublisher();
    }
  });

  /*
   * 「连接在，但对端不回包」（半开 TCP / Redis 被 STOP / 网络分区）是断连之外的
   * 另一种故障形态：ioredis 既不报错也不重连，没有上界时 `await publish` 永不返回，
   * /chat 会从「500」变成「永不返回」。
   *
   * 用例自建一个**只 accept、从不 write** 的 TCP 服务来稳定复现该形态。
   */
  it('连接在但对端不回包时，发布在硬上界内返回 null（不会无限挂起）', async () => {
    const fake = await startFakeRedis(() => null);
    const healthyEnv = getEnv();
    await closeEventPublisher();
    __setEnvForTesting({ ...healthyEnv, REDIS_URL: `redis://127.0.0.1:${String(fake.port)}` });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedAt = Date.now();
    try {
      const result = await publishSessionEvent('task6-halfopen-probe', 'agent.state', {
        state: 'thinking',
      });
      const elapsed = Date.now() - startedAt;

      expect(result).toBeNull();
      // TCP 确实建立了：否则测到的是「连不上」而不是「不回包」
      expect(fake.sockets.length).toBeGreaterThan(0);
      // 既没有被立刻拒绝，也没有无限挂起
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(2_000);
      // 失败被观察到并记录（发布器命令超时，或 API 侧硬上界）
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('[realtime]'))).toBe(true);
    } finally {
      __setEnvForTesting(healthyEnv);
      await fake.close();
      await closeEventPublisher();
      warnSpy.mockRestore();
    }
  });

  /*
   * 上一例由发布器的单命令超时兜住；这一例专测 **API 侧 Promise.race 硬上界**：
   * incr 立刻回包（单命令都不超时），但 xadd 与 expire 各要 450ms，
   * 三次串行叠加远超 500ms 的硬上界。没有 Promise.race 时这里会等到
   * 命令跑完（约 900ms），断言 `elapsed < 700` 会立刻变红。
   */
  it('单命令都不超时但串行叠加超过上界时，由 API 侧硬上界兜住', async () => {
    const fake = await startFakeRedis((command) =>
      command === 'xadd' || command === 'expire' ? 450 : 0,
    );
    const healthyEnv = getEnv();
    await closeEventPublisher();
    __setEnvForTesting({ ...healthyEnv, REDIS_URL: `redis://127.0.0.1:${String(fake.port)}` });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedAt = Date.now();
    try {
      const result = await publishSessionEvent('task6-race-probe', 'agent.state', {
        state: 'thinking',
      });
      const elapsed = Date.now() - startedAt;

      expect(result).toBeNull();
      expect(fake.sockets.length).toBeGreaterThan(0);
      expect(elapsed).toBeGreaterThanOrEqual(400);
      // 在 500ms 上界附近返回，而不是等三条命令跑完（约 900ms）
      expect(elapsed).toBeLessThan(700);
      // 走的是 API 侧上界分支：这条告警只可能由 events.ts 的 Promise.race 发出
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('事件发布超时')),
      ).toBe(true);
    } finally {
      __setEnvForTesting(healthyEnv);
      await fake.close();
      await closeEventPublisher();
      warnSpy.mockRestore();
    }
  });
});

/*
 * 「发布失败不影响业务」这条全任务最核心的约定，必须用**真实业务写路径**验证，
 * 而不只是验证发布器自身（发布器的失败路径由 @svh/realtime 自己的测试覆盖）。
 *
 * ── 为什么必须放在不加 gate 的分组里 ──
 * 本用例只需要 Postgres：它在用例内伪造的恰恰是「Redis 不可用」。
 * 留在 `describe.skipIf(!canRun)` 里，在没有 Redis 的机器上会被静默跳过 ——
 * 而「机器上没有 Redis」正是这条契约最可能失守的场景：测试全绿，什么都没验证。
 * 仓库里已经因为同一个模式修过三次（b838263、Task 3 fix round 1、Task 6 fix round 1）。
 *
 * ── 为什么要显式注入一份配置 ──
 * `buildApp()` 第一件事是 `getEnv()`，而 @svh/config 对 REDIS_URL 是 fail-fast 校验
 * （空串 / 非 redis:// 前缀直接 EnvValidationError）。也就是说「把 REDIS_URL 置空」
 * 并不能模拟「没有 Redis 的机器」，只会让应用根本装配不起来 —— 那样这条用例仍然
 * 证明不了任何事。这里注入一份**结构合法、指向无人监听端口**的配置：用例在断言前
 * 就会把 REDIS_URL 换成非法值，因此外部有没有 Redis 都不影响它的执行路径。
 */
describe('发布失败不影响业务', () => {
  let app: FastifyInstance;
  let projectId: string;
  let envBackup: ReturnType<typeof getEnv> | null = null;

  beforeAll(async () => {
    try {
      envBackup = getEnv();
    } catch {
      // REDIS_URL 被显式置空时 getEnv() 会 fail-fast，这正是「无 Redis 机器」的形态
      envBackup = null;
    }
    // 用 process.env 兜底解析，缺省项由 Schema 的默认值补齐，避免手写配置遗漏字段
    __setEnvForTesting(parseEnv({ ...process.env, REDIS_URL: 'redis://127.0.0.1:1' }));

    app = await buildApp({ logLevel: 'silent' });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: `Task9 发布故障验证项目 ${Date.now()}` },
    });
    projectId = res.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app.close();
    // 发布器与队列池都是进程内单例，必须释放，否则测试进程挂着不退
    await closeEventPublisher();
    await closeQueuePool();
    await disconnectPrisma();
    __setEnvForTesting(envBackup);
    envBackup = null;
  });

  /*
   * 用非法 REDIS_URL 制造「发布器**构造期**就抛错」：取消操作本身必须照常生效
   * （204 + 库里 cancelled），被放弃的只有广播。
   * 若新代码绕过 publishSessionEvent 的兜底契约（例如直接调发布器），
   * 这里会变成 500 —— 取消是用户可见操作，绝不能因为 Redis 抖动而失败。
   */
  it('发布器不可用时取消照常生效，只是没有广播', async () => {
    const session = await prisma.session.create({
      data: { projectId, title: '取消时的发布故障' },
      select: { id: true },
    });
    const task = await prisma.agentTask.create({
      data: {
        projectId,
        sessionId: session.id,
        skillId: 'asset.create',
        queueName: 'asset',
        status: 'running',
        input: {},
      },
      select: { id: true },
    });

    const healthyEnv = getEnv();
    // 单例可能已被前一个用例建好，先关掉，确保下一次 getEventPublisher() 重新构造
    await closeEventPublisher();
    __setEnvForTesting({ ...healthyEnv, REDIS_URL: 'redis://[]' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/cancel`,
        payload: { reason: '用户取消' },
      });
      expect(res.statusCode).toBe(204);
      // 确实是走到了「发布器不可用」的兜底分支，而不是恰好没触发发布
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('事件发布器不可用')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      __setEnvForTesting(healthyEnv);
      await closeEventPublisher();
    }

    // 广播被放弃，但业务写入必须照常生效
    const stored = await prisma.agentTask.findUnique({
      where: { id: task.id },
      select: { status: true },
    });
    expect(stored?.status).toBe('cancelled');
  });
});

/*
 * 跳过路径**不需要 Redis**，因此刻意放在不加 gate 的分组里。
 *
 * 把它留在被 skipIf 的分组中，在没有 REDIS_URL 的机器上就会被静默跳过 ——
 * 仓库里已经因为同一个模式修过两次（b838263、Task 3 的 fix round 1）。
 */
describe('事件发布的跳过路径', () => {
  it('sessionId 为空时直接跳过，不报错也不发布', async () => {
    await expect(publishSessionEvent(null, 'agent.state', { state: 'thinking' })).resolves.toBeNull();
    await expect(publishSessionEvent('', 'agent.state', { state: 'thinking' })).resolves.toBeNull();
    await expect(
      publishSessionEvent(undefined, 'agent.state', { state: 'thinking' }),
    ).resolves.toBeNull();
  });
});
