/**
 * Worker 事件汇聚器测试（Task 8）
 *
 * 只测「发射后不管」这一契约：emit 必须同步返回、不抛异常
 * （同步异常不外冒，异步 rejection 也不能变成未处理拒绝），
 * 且在没有会话归属时直接跳过。
 *
 * ── 为什么不把全部用例都塞进 Redis 分组 ──
 * 上述 5 条契约**不需要外部服务**，若跟着 Redis 用例一起被 `skipIf` 关掉，
 * 在没有 Redis 的机器上就会「全绿但什么都没验证」（仓库里已经犯过几次）。
 * 因此只有真正读回 Redis Stream 的那条接线用例才进被 gate 的分组。
 *
 * ── 为什么 REDIS_URL 必须在模块作用域读取 ──
 * `describe.skipIf` 在**收集阶段**求值，早于任何 beforeAll 钩子；
 * 若把加载推迟到钩子里，判断永远拿到空串，接线用例会被静默跳过。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadEnvFile } from '@svh/config';
import { parseRedisConnection } from '@svh/queue';
import {
  createEventPublisher,
  createEventStream,
  type EventPublisher,
  type StreamedEvent,
} from '@svh/realtime';

import { createEventSink, NOOP_EVENT_SINK } from '../src/events.js';

// 必须在读 process.env 之前加载：收集期的 skipIf 依赖它
loadEnvFile(process.cwd());

const redisUrl = process.env.REDIS_URL ?? '';
const canRun = redisUrl.length > 0;

/**
 * 读取某个会话的事件流。
 *
 * 用 `@svh/realtime` 的订阅器（SSE 端点的同一条消费路径）读取，
 * 而不是直连 ioredis —— 后者不是 apps/worker 的依赖。
 */
async function collectEvents(sessionId: string, expected: number): Promise<StreamedEvent[]> {
  const stream = createEventStream({ connection: parseRedisConnection(redisUrl) });
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

describe('EventSink 契约', () => {
  it('把事件转交给发布器', () => {
    const publish = vi.fn().mockResolvedValue({ streamId: '1-0', seq: 1, at: 'now' });
    const sink = createEventSink({ publish, close: vi.fn() });

    sink.emit({ sessionId: 'sess_1', type: 'task.progress', data: { progress: 10 } });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toEqual({
      sessionId: 'sess_1',
      type: 'task.progress',
      data: { progress: 10 },
    });
  });

  it('没有会话归属时跳过，不调用发布器', () => {
    const publish = vi.fn().mockResolvedValue(null);
    const sink = createEventSink({ publish, close: vi.fn() });

    sink.emit({ sessionId: null, type: 'task.progress', data: {} });
    sink.emit({ sessionId: undefined, type: 'task.progress', data: {} });
    sink.emit({ sessionId: '', type: 'task.progress', data: {} });

    expect(publish).not.toHaveBeenCalled();
  });

  it('emit 是同步的，不会等待发布完成', () => {
    let resolved = false;
    const publish = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(null);
          }, 50);
        }),
    );
    const sink = createEventSink({ publish, close: vi.fn() });

    const returned = sink.emit({ sessionId: 'sess_1', type: 'task.status', data: {} });

    // 返回值必须是 undefined 而不是 Promise（这条断言的证伪方式：把 emit 写成
    // `async … await publisher.publish(...)`，它会立刻返回 Promise 而失败）；
    // 只断言下面那句「发布尚未完成」是没有证伪力的 —— 发布 50ms 后才 resolve，
    // 无论 emit 同步还是异步，紧接着求值都必然是 false。
    expect(returned).toBeUndefined();

    // emit 返回时发布尚未完成
    expect(resolved).toBe(false);
  });

  it('发布器异步 reject 时不会产生未处理拒绝', async () => {
    // publish 契约上不 reject，但它内部的 logger 可能抛异常（例如 stdout EPIPE），
    // 那时返回的 Promise 会 reject。emit 若不挂 catch，这个 rejection 无人处理，
    // 会以 unhandledRejection 掀掉整个 Worker 进程。
    //
    // 刻意**不用 `vi.fn()`**：vitest 会给 mock 返回的 Promise 挂内部处理
    // （跟踪 settledResults），连没有兜底的实现也观察不到未处理拒绝 ——
    // 用例会变成恒真（已实测：裸 Promise.reject 能被观察到，mock 的不能）。
    let calls = 0;
    const publisher: EventPublisher = {
      publish: () => {
        calls += 1;
        return Promise.reject(new Error('发布时日志炸了'));
      },
      close: () => Promise.resolve(),
    };
    const sink = createEventSink(publisher);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      sink.emit({ sessionId: 'sess_1', type: 'task.status', data: {} });
      // 排空事件循环：未处理的 rejection 在 emit 之后的微任务里上报
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(calls).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('发布器抛出的同步异常不会冒泡到调用方', () => {
    const publish = vi.fn().mockImplementation(() => {
      throw new Error('同步炸了');
    });
    const sink = createEventSink({ publish, close: vi.fn() });

    expect(() => sink.emit({ sessionId: 'sess_1', type: 'task.status', data: {} })).not.toThrow();
  });

  it('空实现不产生任何副作用', () => {
    expect(() => NOOP_EVENT_SINK.emit({ sessionId: 'x', type: 'ping', data: {} })).not.toThrow();
  });
});

describe.skipIf(!canRun)('接入真实 Redis', () => {
  let publisher: EventPublisher;

  afterAll(async () => {
    if (publisher !== undefined) await publisher.close();
  });

  /**
   * 接线验证：证明 `emit` 的事件**真的落进了 Redis Stream**。
   *
   * 这条用例能证伪真正的风险 —— emit 被写成只调用了本地函数、
   * 或会话 id 传错：那样订阅端什么也读不到（或读到别的会话的流）。
   * `emit` 是「发射后不管」的，因此这里靠订阅端阻塞等待，而不是 emit 之后立刻断言。
   */
  it('emit 之后事件真的进入会话 Stream', async () => {
    publisher = createEventPublisher({ connection: parseRedisConnection(redisUrl) });
    const sink = createEventSink(publisher);
    const sessionId = `sess_test_worker_${Date.now()}`;

    sink.emit({
      sessionId,
      type: 'task.progress',
      data: { taskId: 'task_1', progress: 42 },
    });

    const events = await collectEvents(sessionId, 1);

    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe(sessionId);
    expect(events[0]?.type).toBe('task.progress');
    expect(events[0]?.data).toEqual({ taskId: 'task_1', progress: 42 });
    expect(events[0]?.seq).toBe(1);
  });
});
