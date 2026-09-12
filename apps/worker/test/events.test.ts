/**
 * Worker 事件汇聚器测试（Task 8）
 *
 * 只测「发射后不管」这一契约：emit 必须同步返回、不抛异常，
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

    sink.emit({ sessionId: 'sess_1', type: 'task.status', data: {} });

    // emit 返回时发布尚未完成
    expect(resolved).toBe(false);
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
