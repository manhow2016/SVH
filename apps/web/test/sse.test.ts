/**
 * SSE 客户端测试。
 *
 * 分两层：
 * - 用假连接（实现同一个 `EventSourceLike` 接口）验证重连 / 退避 / 陈旧度判据；
 * - 用打桩的 fetch 验证**默认传输层真正发出去的请求** —— 续传游标必须落在
 *   `Last-Event-ID` 请求头里，因为服务端只读这个头（见 apps/api/src/routes/events.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionStream, type SseEnvelope, type StreamConnectionInit } from '../src/lib/sse.js';

/** 一个合法的 Redis Stream ID（服务端写进 SSE `id:` 的就是它） */
const STREAM_ID = '1757692800000-0';

/** 可控的假连接：与默认传输层实现同一个接口 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly lastEventId: string | null;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  /** 浏览器语义：`id:` 会一直沿用，直到某帧显式给出新值 */
  private cursor: string;

  constructor(init: StreamConnectionInit) {
    this.url = init.url;
    this.lastEventId = init.lastEventId;
    this.cursor = init.lastEventId ?? '';
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** 模拟连接建立 */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /**
   * 模拟收到一帧。
   *
   * `streamId` 对应服务端写下的 `id:`。**不传就表示这一帧没有 `id:`** ——
   * 心跳帧如此，「带游标重连时的 session.ready」也如此（服务端刻意省略，
   * 免得把客户端游标提前推到新基准）。此时按浏览器语义沿用上一帧的值。
   */
  emit(type: string, envelope: SseEnvelope, streamId?: string): void {
    if (streamId !== undefined) this.cursor = streamId;
    const event = new MessageEvent(type, {
      data: JSON.stringify(envelope),
      lastEventId: this.cursor,
    });
    this.onmessage?.(event);
  }

  /** 模拟连接中断 */
  emitError(): void {
    this.onerror?.(new Event('error'));
  }
}

/** 注入点：把连接参数原样交给假连接，便于断言「游标真的传下去了」 */
function fakeConnection(init: StreamConnectionInit): FakeEventSource {
  return new FakeEventSource(init);
}

function envelope(overrides: Partial<SseEnvelope> = {}): SseEnvelope {
  return {
    seq: 1,
    type: 'agent.message',
    at: new Date().toISOString(),
    sessionId: 'sess_1',
    data: { message: '你好' },
    ...overrides,
  };
}

/** 手工可控的 SSE 响应体：可以按需推入数据块，模拟网络分片 */
function streamingSseResponse(): {
  response: Response;
  push: (text: string) => void;
  end: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(created) {
      controller = created;
    },
  });
  const encoder = new TextEncoder();

  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
    push: (text) => {
      controller?.enqueue(encoder.encode(text));
    },
    end: () => {
      controller?.close();
    },
  };
}

/** 跑若干轮微任务：让传输层的读取循环推进（不涉及定时器） */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createSessionStream', () => {
  it('首次连接不带游标，URL 就是事件端点', () => {
    createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
    });

    const first = FakeEventSource.instances[0];
    expect(first?.url).toBe('/api/agent/sessions/sess_1/events');
    expect(first?.lastEventId).toBeNull();
  });

  it('收到事件后回调，并记录最后一次业务事件时间', () => {
    const clock = { now: 1_000_000 };
    const onEvent = vi.fn();
    const onStateChange = vi.fn();

    const stream = createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent,
      onStateChange,
      now: () => clock.now,
      staleAfterMs: 30_000,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    expect(onStateChange).toHaveBeenCalledWith('open');

    clock.now = 1_020_000;
    source?.emit('agent.message', envelope({ seq: 7 }), STREAM_ID);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ seq: 7, type: 'agent.message' });
    expect(stream.lastEventAt()).toBe(1_020_000);
  });

  it('断线后按退避重连，游标取自 SSE 帧的 id:（不是信封里的 seq）', () => {
    vi.useFakeTimers();

    createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
    });

    const first = FakeEventSource.instances[0];
    first?.emitOpen();
    first?.emit('task.progress', envelope({ seq: 12 }), STREAM_ID);
    first?.emitError();

    // 第一次退避 1000ms：差 1ms 都不该重连
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(FakeEventSource.instances).toHaveLength(2);
    // 续传点必须是 Redis Stream ID。传 seq 的话服务端认不出来（格式都不对），
    // 断线期间的事件会永久丢失。
    expect(FakeEventSource.instances[1]?.lastEventId).toBe(STREAM_ID);
    expect(FakeEventSource.instances[1]?.url).toBe('/api/agent/sessions/sess_1/events');
  });

  it('游标只前进不回退（乱序到达的旧 id 不会把续传点拉回去）', () => {
    vi.useFakeTimers();

    createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    source?.emit('task.progress', envelope({ seq: 2 }), '1757692800000-1');
    // 乱序 / 重复帧：更小的 Stream ID 不该覆盖已前进的游标
    source?.emit('task.progress', envelope({ seq: 1 }), '1757692800000-0');
    source?.emitError();
    vi.advanceTimersByTime(1000);

    expect(FakeEventSource.instances[1]?.lastEventId).toBe('1757692800000-1');
  });

  it('退避逐次递增，到顶后保持（不无限增长）', () => {
    vi.useFakeTimers();

    createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
    });

    const delays = [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000];
    for (const [index, delay] of delays.entries()) {
      FakeEventSource.instances[index]?.emitError();

      vi.advanceTimersByTime(delay - 1);
      expect(FakeEventSource.instances).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(index + 2);
    }
  });

  it('连接建立后退避计数归零，下一次断线仍从最短退避开始', () => {
    vi.useFakeTimers();

    createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
    });

    FakeEventSource.instances[0]?.emitError();
    vi.advanceTimersByTime(1000);
    FakeEventSource.instances[1]?.emitError();
    vi.advanceTimersByTime(2000);
    expect(FakeEventSource.instances).toHaveLength(3);

    // 第三连接建立成功 → 计数归零
    FakeEventSource.instances[2]?.emitOpen();
    FakeEventSource.instances[2]?.emitError();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it('ping 与 session.ready 都不刷新「最后业务事件」时间（半开链路的关键守卫）', () => {
    const clock = { now: 1_000_000 };

    const stream = createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
      now: () => clock.now,
      staleAfterMs: 30_000,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();

    clock.now = 1_010_000;
    source?.emit('session.ready', envelope({ seq: 1, type: 'session.ready' }), STREAM_ID);
    clock.now = 1_020_000;
    source?.emit('task.progress', envelope({ seq: 2, type: 'task.progress' }), STREAM_ID);

    expect(stream.lastEventAt()).toBe(1_020_000);

    // 时间前进 60 秒，期间只收到心跳与建连确认 —— 连接「看起来」完全健康
    clock.now = 1_080_000;
    source?.emit('ping', envelope({ seq: 3, type: 'ping' }));
    source?.emit('session.ready', envelope({ seq: 4, type: 'session.ready' }));

    expect(stream.lastEventAt()).toBe(1_020_000);
    expect(stream.isEventStale()).toBe(true);
  });

  it('从未收到业务事件时：建连瞬间不误报陈旧，超过阈值才算', () => {
    const clock = { now: 500_000 };

    const stream = createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
      now: () => clock.now,
      staleAfterMs: 30_000,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();

    expect(stream.lastEventAt()).toBeNull();
    expect(stream.isEventStale()).toBe(false);

    clock.now += 30_001;
    expect(stream.isEventStale()).toBe(true);
  });

  it('收到新的业务事件后不再陈旧', () => {
    const clock = { now: 1_000_000 };

    const stream = createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
      now: () => clock.now,
      staleAfterMs: 30_000,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    clock.now += 60_000;
    expect(stream.isEventStale()).toBe(true);

    source?.emit('task.progress', envelope({ seq: 3 }), STREAM_ID);
    expect(stream.isEventStale()).toBe(false);
  });

  it('单条坏数据不会打断整条推送链路', () => {
    const onEvent = vi.fn();

    createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    source?.onmessage?.(new MessageEvent('message', { data: '{ 不是 JSON' }));
    source?.emit('task.progress', envelope({ seq: 9 }), STREAM_ID);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ seq: 9 });
  });

  it('close 之后不再重连，且不再收到任何回调', () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onStateChange = vi.fn();
    const onError = vi.fn();

    const stream = createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent,
      onStateChange,
      onError,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    stream.close();

    expect(stream.state).toBe('closed');
    expect(source?.closed).toBe(true);
    // 监听器必须摘干净，否则断开后仍会有回调打进已经关掉的流
    expect(source?.onerror).toBeNull();
    expect(source?.onmessage).toBeNull();
    expect(source?.onopen).toBeNull();

    source?.emitError();

    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });
});

/**
 * 默认传输层。
 *
 * ── 为什么不是原生 EventSource ──
 * 服务端（apps/api/src/routes/events.ts）**只**读 `Last-Event-ID` 请求头来续传，
 * 没有任何查询参数分支；而原生 EventSource 既不能自定义请求头，新建实例也不会
 * 继承上一个实例的游标 —— 「自定义退避 + 游标续传」两者无法同时成立。
 * 因此默认传输层用 fetch + ReadableStream 自己解析 SSE，游标走请求头。
 */
describe('默认传输层（fetch 版）', () => {
  it('用 GET 请求事件端点，首次连接不带 Last-Event-ID 头', async () => {
    const body = streamingSseResponse();
    const fetchMock = vi.fn().mockResolvedValue(body.response);
    vi.stubGlobal('fetch', fetchMock);

    const stream = createSessionStream({ sessionId: 'sess_1', onEvent: () => undefined });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agent/sessions/sess_1/events');
    expect(new Headers(init.headers).has('Last-Event-ID')).toBe(false);

    stream.close();
  });

  it('事件端点返回的不是事件流时按失败处理，而不是假装连接正常', async () => {
    // 反向代理的 HTML 错误页、被误路由到 REST 的 JSON 都会长这样
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"error":"nope"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const onError = vi.fn();
    const stream = createSessionStream({
      sessionId: 'sess_1',
      onEvent: () => undefined,
      onError,
    });

    await vi.waitFor(() => {
      expect(stream.state).toBe('reconnecting');
    });
    expect(onError).toHaveBeenCalledTimes(1);

    stream.close();
  });

  it('按 SSE 规范解析帧：跨数据块分片的帧不会丢，也不会提前派发', async () => {
    const body = streamingSseResponse();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));

    const onEvent = vi.fn();
    const stream = createSessionStream({ sessionId: 'sess_1', onEvent });

    const frame = `id: ${STREAM_ID}\nevent: agent.message\ndata: ${JSON.stringify(
      envelope({ seq: 3 }),
    )}\n\n`;

    // 网络分片不会照顾帧边界：从中间切开
    body.push(frame.slice(0, 20));
    await flushMicrotasks();
    expect(onEvent).not.toHaveBeenCalled();

    body.push(frame.slice(20));
    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledTimes(1);
    });
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ seq: 3, type: 'agent.message' });

    stream.close();
  });

  it('服务端断流后按退避重连，重连请求带上 Last-Event-ID 头', async () => {
    const first = streamingSseResponse();
    const second = streamingSseResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    vi.stubGlobal('fetch', fetchMock);

    const stream = createSessionStream({ sessionId: 'sess_1', onEvent: () => undefined });

    first.push(
      `id: ${STREAM_ID}\nevent: task.progress\ndata: ${JSON.stringify(
        envelope({ seq: 12, type: 'task.progress' }),
      )}\n\n`,
    );
    await vi.waitFor(() => {
      expect(stream.lastEventAt()).not.toBeNull();
    });

    first.end();

    // 第一次退避是 1000ms
    await vi.waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new Headers(init.headers).get('Last-Event-ID')).toBe(STREAM_ID);

    stream.close();
  });

  it('close 会中止在途请求，之后不再重连', async () => {
    const body = streamingSseResponse();
    const fetchMock = vi.fn().mockResolvedValue(body.response);
    vi.stubGlobal('fetch', fetchMock);

    const onError = vi.fn();
    const stream = createSessionStream({
      sessionId: 'sess_1',
      onEvent: () => undefined,
      onError,
    });
    await vi.waitFor(() => {
      expect(stream.state).toBe('open');
    });

    stream.close();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
