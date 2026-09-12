/**
 * 事件订阅器测试
 *
 * 重点覆盖四件事：
 * 1. 补发：afterId 之后的历史事件要能取回
 * 2. 实时：订阅建立**之后**发布的事件要能收到（这是审计 P0 缺陷 ⑫ 的正面证明）
 * 3. 取消：能立即结束，不必等阻塞超时；**补发阶段**被取消也要干净结束
 * 4. 补发失败的降级：记 warn 后转纯实时，不把异常抛给消费方
 * 5. 有界降级：游标**永久**不可恢复时（XRANGE 与 XREAD 都拒绝该 id），
 *    订阅要在有限时间内结束，而不是无限 warn + idle 空转（fix round 2 的证伪点）
 *
 * 第 3 条里「连不上 Redis」的取消用例不依赖真实 Redis，
 * 因此放在 gated 分组**之外**，没有 REDIS_URL 时同样执行（沿用 5741237 的约定）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile } from '@svh/config';

import {
  createEventPublisher,
  createEventStream,
  NOOP_REALTIME_LOGGER,
  type EventPublisher,
  type EventSubscriber,
  type RealtimeLogger,
  type RealtimeMessage,
  type RedisConnectionOptions,
  type StreamedEvent,
} from '../src/index.js';

/*
 * .env 必须在**模块作用域**加载，且必须早于下面的 `process.env.REDIS_URL` 读取。
 *
 * `describe.skipIf` 与 `const canRun` 都在 vitest 的**收集阶段**求值，
 * 早于任何 beforeAll 钩子；若把加载推迟到 beforeAll（或写在读取 url 之后），
 * 这里读到的 REDIS_URL 永远是空串，整组用例会被静默跳过 ——
 * 测试全绿但零验证。这与 @svh/queue 的修复（b838263）是同一个坑。
 */
loadEnvFile(process.cwd());

const url = process.env.REDIS_URL ?? '';
const canRun = url.length > 0;

let publisher: EventPublisher;
let stream: EventSubscriber;
let connection: RedisConnectionOptions;

let counter = 0;
function nextSessionId(): string {
  counter += 1;
  return `sess_test_sub_${Date.now()}_${counter}`;
}

/*
 * 指向本机一个必然没有服务的端口（1 号端口要 root 才能监听）。
 *
 * 连接会被拒绝，而 `maxRetriesPerRequest: null` 让 XRANGE 一直挂在离线队列里等重连，
 * 因此补发阶段**永远不会完成** —— 这样才能稳定复现「取消发生在补发阶段」这条路径，
 * 而不是靠运气抢在那几毫秒的窗口里 abort。
 */
const UNREACHABLE_CONNECTION: RedisConnectionOptions = { host: '127.0.0.1', port: 1 };

/** 记录 warn / error 文案的日志器，用于断言降级路径确实落了日志 */
function createRecordingLogger(warnings: string[], errors: string[] = []): RealtimeLogger {
  return {
    ...NOOP_REALTIME_LOGGER,
    warn: (msg) => {
      warnings.push(msg);
    },
    error: (msg) => {
      errors.push(msg);
    },
  };
}

/** 在后台消费订阅，把事件推进 received，直到超时或取消 */
function consume(
  sessionId: string,
  afterId: string,
  signal: AbortSignal,
  sink: StreamedEvent[],
): Promise<void> {
  return (async () => {
    for await (const message of stream.subscribe({ sessionId, afterId, blockMs: 300, signal })) {
      if (message.kind === 'event') sink.push(message.event);
    }
  })();
}

/** 等待条件成立，最多等 timeoutMs */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterAll(async () => {
  if (publisher !== undefined) await publisher.close();
});

describe.skipIf(!canRun)('事件订阅器', () => {
  beforeAll(async () => {
    const { parseRedisConnection } = await import('@svh/queue');
    connection = parseRedisConnection(url);
    publisher = createEventPublisher({ connection });
    stream = createEventStream({ connection });
  });

  it('补发 afterId 之后的历史事件', async () => {
    const sessionId = nextSessionId();
    const first = await publisher.publish({ sessionId, type: 'agent.message', data: { n: 1 } });
    await publisher.publish({ sessionId, type: 'agent.message', data: { n: 2 } });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    const task = consume(sessionId, first?.streamId ?? '0', controller.signal, sink);

    await waitFor(() => sink.length >= 1);
    controller.abort();
    await task;

    // afterId 自身不算补发内容，因此只应收到第 2 条
    expect(sink.map((e) => e.data)).toEqual([{ n: 2 }]);
  });

  it('订阅建立之后发布的事件能实时收到', async () => {
    const sessionId = nextSessionId();
    const ready = await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    const task = consume(sessionId, ready?.streamId ?? '0', controller.signal, sink);

    // 关键：先确认订阅已建立（进入阻塞），再发布。这样才真正验证「实时」。
    await new Promise((resolve) => setTimeout(resolve, 200));
    await publisher.publish({ sessionId, type: 'task.progress', data: { progress: 80 } });

    await waitFor(() => sink.length >= 1);
    controller.abort();
    await task;

    expect(sink).toHaveLength(1);
    expect(sink[0]?.type).toBe('task.progress');
    expect(sink[0]?.data).toEqual({ progress: 80 });
  });

  it('afterId 不存在于流中（已被裁剪）时补发全部现存事件', async () => {
    const sessionId = nextSessionId();
    await publisher.publish({ sessionId, type: 'agent.message', data: { n: 1 } });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    // 一个早于任何真实记录的 id
    const task = consume(sessionId, '1-0', controller.signal, sink);

    await waitFor(() => sink.length >= 1);
    controller.abort();
    await task;

    expect(sink).toHaveLength(1);
  });

  it('无事件时产出 idle，供调用方发送心跳', async () => {
    const sessionId = nextSessionId();
    const ready = await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const kinds: string[] = [];
    const task = (async () => {
      for await (const message of stream.subscribe({
        sessionId,
        afterId: ready?.streamId ?? '0',
        blockMs: 200,
        signal: controller.signal,
      })) {
        kinds.push(message.kind);
      }
    })();

    await waitFor(() => kinds.includes('idle'), 5000);
    controller.abort();
    await task;

    expect(kinds).toContain('idle');
  });

  it('取消信号能立即结束订阅，不必等待阻塞超时', async () => {
    const sessionId = nextSessionId();
    const ready = await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    // 阻塞时长故意设得很长（10 秒）
    const task = (async () => {
      for await (const message of stream.subscribe({
        sessionId,
        afterId: ready?.streamId ?? '0',
        blockMs: 10_000,
        signal: controller.signal,
      })) {
        if (message.kind === 'event') sink.push(message.event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    controller.abort();
    await task;
    const elapsed = Date.now() - started;

    // 若实现依赖阻塞超时，这里会等到 10 秒
    expect(elapsed).toBeLessThan(2000);
  });

  it('不同会话的订阅互不干扰', async () => {
    const sessionA = nextSessionId();
    const sessionB = nextSessionId();
    const readyA = await publisher.publish({ sessionId: sessionA, type: 'session.ready', data: {} });
    const readyB = await publisher.publish({ sessionId: sessionB, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const sinkB: StreamedEvent[] = [];
    const taskB = consume(sessionB, readyB?.streamId ?? '0', controller.signal, sinkB);

    await new Promise((resolve) => setTimeout(resolve, 200));
    // 只往 A 发，B 不应收到
    await publisher.publish({ sessionId: sessionA, type: 'agent.message', data: { to: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 400));

    controller.abort();
    await taskB;

    expect(sinkB).toHaveLength(0);
    expect(readyA).not.toBeNull();
  });

  it('补发失败（afterId 非法）时降级为纯实时并继续推送，不抛异常', async () => {
    const sessionId = nextSessionId();
    await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    /*
     * `'$'` 是一个「XRANGE 拒绝、XREAD 接受」的 id：
     *   XRANGE key $ +  → ERR Invalid stream ID specified as stream command argument
     *   XREAD  ... $   → 合法（只收调用之后的新记录）
     * 正好构造出「补发失败、实时仍可用」，对应客户端把 Last-Event-ID 篡改成非法值的场景。
     */
    const warnings: string[] = [];
    const degradedStream = createEventStream({
      connection,
      logger: createRecordingLogger(warnings),
    });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    const task = (async () => {
      for await (const message of degradedStream.subscribe({
        sessionId,
        afterId: '$',
        blockMs: 2000,
        signal: controller.signal,
      })) {
        if (message.kind === 'event') sink.push(message.event);
      }
    })();

    // 补发失败必须留下一条 warn，然后转入实时阶段（而不是把异常抛给消费方）
    await waitFor(() => warnings.length >= 1);
    // 等实时阶段确实进入阻塞再发布，保证事件落在 XREAD 的区间里
    await new Promise((resolve) => setTimeout(resolve, 200));
    await publisher.publish({ sessionId, type: 'task.progress', data: { progress: 55 } });

    await waitFor(() => sink.length >= 1);
    controller.abort();
    await task;

    expect(warnings).toContain('补发事件流失败，降级为纯实时订阅');
    expect(sink).toHaveLength(1);
    expect(sink[0]?.type).toBe('task.progress');
    expect(sink[0]?.data).toEqual({ progress: 55 });
  });

  it('afterId 永久非法时订阅有界结束，而不是无限 warn + idle 空转', async () => {
    const sessionId = nextSessionId();
    await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    /*
     * `'not-a-stream-id'` 既不是合法流 ID、也不是 `$`：实测（ioredis@5.11.1 + 本机 Redis）
     *   XRANGE key not-a-stream-id +  → ERR Invalid stream ID specified as stream command argument（11ms）
     *   XREAD  ... STREAMS key not-a-stream-id → 同上（10ms，命令级错误，ioredis 只 reject、不重连）
     * 于是补发降级成纯实时后，实时阶段的游标仍然永久不可用：每次 XREAD 都立刻失败，
     * 游标永远读不到 entries 也就永不前推。
     *
     * 这正是 fix round 1 引入的失败模式：无退避的 `warn + idle + continue` 死循环 ——
     * 订阅既不产出事件、也永不结束，日志无界增长。本用例就是它的证伪点。
     */
    const warnings: string[] = [];
    const errors: string[] = [];
    const degradedStream = createEventStream({
      connection,
      logger: createRecordingLogger(warnings, errors),
    });

    const controller = new AbortController();
    const received: RealtimeMessage[] = [];
    const started = Date.now();
    const task = (async () => {
      for await (const message of degradedStream.subscribe({
        sessionId,
        afterId: 'not-a-stream-id',
        blockMs: 200,
        signal: controller.signal,
      })) {
        received.push(message);
      }
    })();

    /*
     * 与一个**明确的上界**竞速，而不是等 vitest 的 30s 用例超时：
     * 实现若仍在空转，这里拿到的是 'timeout'，下面的断言会直接失败，
     * 用例本身也照样能在 3s 内收尾（不会挂死、不会侥幸通过）。
     */
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      task.then(() => 'finished' as const),
      new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), 3000);
      }),
    ]);
    const elapsed = Date.now() - started;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    // 兜底：即使实现有 bug（上界内没结束），也要 abort 掉，保证用例干净收尾
    controller.abort();
    await task;

    expect(outcome).toBe('finished');
    expect(elapsed).toBeLessThan(3000);
    // 结束必须来自「游标不可恢复」这条 error，而不是继续刷普通读取失败
    expect(errors).toContain('事件流游标不可恢复，结束订阅');
    // 日志有界：K=3 次失败中前 2 次记 warn，第 3 次直接记 error 并结束
    expect(warnings.filter((msg) => msg === '读取事件流失败')).toHaveLength(2);
    // 游标永久不可用 → 全程零事件
    expect(received.filter((message) => message.kind === 'event')).toHaveLength(0);
  });
});

/*
 * 以下用例不依赖真实 Redis：它们验证的是「取消」与「补发失败」这两条
 * 不涉及业务数据的路径，因此不放进 describe.skipIf(!canRun)。
 */
describe('事件订阅器：补发阶段的取消与兜底', () => {
  it('补发尚未完成时取消，订阅正常结束而不是抛异常', async () => {
    const warnings: string[] = [];
    // 连不上的地址 → XRANGE 永不返回，取消必然落在补发阶段
    const unreachableStream = createEventStream({
      connection: UNREACHABLE_CONNECTION,
      logger: createRecordingLogger(warnings),
    });

    const controller = new AbortController();
    const received: RealtimeMessage[] = [];
    const task = (async () => {
      for await (const message of unreachableStream.subscribe({
        sessionId: nextSessionId(),
        afterId: '0-0',
        blockMs: 100,
        signal: controller.signal,
      })) {
        received.push(message);
      }
    })();

    // 给 XRANGE 留出「已发出、但迟迟不返回」的时间，再取消
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();

    /*
     * 取消必然落在补发阶段：ioredis 处于「重连中」，挂起的 XRANGE 既不会被
     * `disconnect()` 拒绝（socket 已销毁），也不会自己返回 —— 实现必须靠自己
     * 的取消兜底结束迭代。补发段若没有 catch，取消抛出的异常会穿过生成器，
     * 这里的 promise 就会 reject → 用例失败。
     */
    await expect(task).resolves.toBeUndefined();
    // 取消发生在补发阶段：没有产出，也不该被记成「补发失败」
    expect(received).toEqual([]);
    expect(warnings).not.toContain('补发事件流失败，降级为纯实时订阅');
  });

  it('订阅前已取消时立即结束，不会去建连等 XRANGE', async () => {
    const unreachableStream = createEventStream({ connection: UNREACHABLE_CONNECTION });
    const controller = new AbortController();
    controller.abort();

    const received: RealtimeMessage[] = [];
    const started = Date.now();
    for await (const message of unreachableStream.subscribe({
      sessionId: nextSessionId(),
      afterId: '0-0',
      blockMs: 100,
      signal: controller.signal,
    })) {
      received.push(message);
    }
    const elapsed = Date.now() - started;

    // 若没有开头的 signal.aborted 判断，订阅会去建连并把 XRANGE 挂在离线队列里，
    // 这个循环永远不会结束（只受 30s 用例超时限制），而不是毫秒级返回。
    expect(received).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });
});
