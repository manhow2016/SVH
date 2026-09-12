/**
 * 事件订阅器测试
 *
 * 重点覆盖三件事：
 * 1. 补发：afterId 之后的历史事件要能取回
 * 2. 实时：订阅建立**之后**发布的事件要能收到（这是审计 P0 缺陷 ⑫ 的正面证明）
 * 3. 取消：能立即结束，不必等阻塞超时
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile } from '@svh/config';

import {
  createEventPublisher,
  createEventStream,
  type EventPublisher,
  type EventSubscriber,
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

let counter = 0;
function nextSessionId(): string {
  counter += 1;
  return `sess_test_sub_${Date.now()}_${counter}`;
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
    const connection = parseRedisConnection(url);
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
});
