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

/**
 * 手工可控的 SSE 响应体：可以按需推入数据块，模拟网络分片。
 *
 * `push` 同时接受字符串与原始字节：要验证「多字节字符被切在两个分片之间」时，
 * 必须能把字节数组从字符中间切开 —— 字符串切不出这种分片。
 */
function streamingSseResponse(): {
  response: Response;
  push: (chunk: string | Uint8Array) => void;
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
    push: (chunk) => {
      controller?.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
    end: () => {
      controller?.close();
    },
  };
}

/** 把若干分片拼成一个字节块（用来把「完整帧 + 半帧」放进同一次 read） */
function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * 求某个字符在 UTF-8 字节流里的起始偏移。
 *
 * 切点用字节算，才能落在**字符内部**（起始偏移 +1 即可）——
 * 按字符串下标切只能切在字符边界上，证明不了 `TextDecoder({ stream: true })`
 * 的跨块续接。
 */
function byteOffsetOf(text: string, char: string): number {
  const index = text.indexOf(char);
  if (index === -1) throw new Error(`测试夹具错误：文本里没有 ${char}`);
  return new TextEncoder().encode(text.slice(0, index)).length;
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

  it('业务帧的游标只前进不回退（乱序到达的旧 id 不会把续传点拉回去）', () => {
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

  it('带 id: 的 session.ready 无条件采纳游标：服务端回退基准游标时客户端跟着回退', () => {
    vi.useFakeTimers();

    createSessionStream({
      sessionId: 'sess_1',
      createConnection: fakeConnection,
      onEvent: () => undefined,
    });

    /*
     * 「合法但超前」的游标：Redis 时钟回拨 / VM 快照恢复后，客户端手里的旧游标
     * 会大于服务端新建的基准游标。这种游标能让 XREAD 永久阻塞，
     * 连接看起来完全健康却再也收不到事件。
     */
    const ahead = '1757692800000-9';
    const baseline = '1757692700000-0';

    const first = FakeEventSource.instances[0];
    first?.emitOpen();
    first?.emit('task.progress', envelope({ seq: 1, type: 'task.progress' }), ahead);
    first?.emitError();
    vi.advanceTimersByTime(1000);

    // 重连把超前游标原样带给了服务端
    const second = FakeEventSource.instances[1];
    expect(second?.lastEventId).toBe(ahead);
    second?.emitOpen();

    /*
     * 服务端判定该游标不可用 → 回退到本次连接的基准游标，并**故意**在 ready 帧上
     * 写 `id:` 把客户端拉回正确位置（契约见 apps/api/test/sse.test.ts 的
     * 「Last-Event-ID 合法但超前时回退到基准游标」）。
     */
    second?.emit('session.ready', envelope({ seq: 0, type: 'session.ready' }), baseline);
    second?.emitError();
    vi.advanceTimersByTime(1000);

    /*
     * 必须采纳这次回退。若 ready 帧也被前向守卫拦住，游标会永久停在超前值上：
     * 之后每次重连都被服务端判为「无游标」（只订阅新事件），
     * 断线期间的事件每次静默丢失。
     */
    expect(FakeEventSource.instances[2]?.lastEventId).toBe(baseline);
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

    const encoder = new TextEncoder();

    /*
     * 第一个分片里放一整帧。
     *
     * 它是这个用例的**确定性信号**：这一帧到达就证明该分片已被读取循环消费完，
     * 不需要靠「跑 N 轮微任务」这类经验值来判断时机。
     */
    const completeChunk = encoder.encode(
      `id: ${STREAM_ID}\nevent: task.progress\ndata: ${JSON.stringify(
        envelope({ seq: 3, type: 'task.progress' }),
      )}\n\n`,
    );

    /*
     * 紧随其后的是被切开的一帧，切点落在 **JSON 内部的中文字符字节中间**。
     *
     * 为什么必须切在这儿：切在 `id:` 行的换行上时，残留缓冲恰好为空，
     * 「有缓冲的正确实现」与「每次 read 都丢掉残留的错误实现」表现完全一样 ——
     * 这样的用例什么都证明不了。切进 JSON 内部（还叠了多字节字符被切断），
     * 丢掉残留就再也拼不回一条合法 JSON，帧永远不会派发。
     */
    const splitFrameText =
      `id: 1757692800000-1\nevent: agent.message\ndata: ${JSON.stringify(
        envelope({ seq: 4, data: { message: '断线期间的事件不能丢' } }),
      )}\n\n`;
    const splitFrame = encoder.encode(splitFrameText);
    // 「断」占 3 个 UTF-8 字节，+1 落在字符中间：TextDecoder 必须开 stream 模式才能续接
    const cut = byteOffsetOf(splitFrameText, '断') + 1;

    body.push(concatBytes(completeChunk, splitFrame.subarray(0, cut)));

    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledTimes(1);
    });
    // 完整帧到达后，残留的半帧绝不能提前派发
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ seq: 3, type: 'task.progress' });

    body.push(splitFrame.subarray(cut));

    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledTimes(2);
    });
    // 多字节字符被切在两个分片之间，也必须完整还原（不能出现替换字符）
    expect(onEvent.mock.calls[1]?.[0]).toMatchObject({
      seq: 4,
      type: 'agent.message',
      data: { message: '断线期间的事件不能丢' },
    });

    stream.close();
  });

  /**
   * 帧解析器的分支覆盖。
   *
   * 解析器是 `sse.ts` 的内部实现（刻意不导出），这里**经由默认传输层喂入分片流** ——
   * 走的是生产路径本身，因此顺带把「字节 → TextDecoder → 缓冲区 → MessageEvent」
   * 这条链路一起覆盖了，比直接调内部函数更有说服力。
   */
  describe('帧解析器的协议分支', () => {
    it('多行 data: 拼成一条数据（只取首行或只取末行都会解析失败）', async () => {
      const body = streamingSseResponse();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));

      const onEvent = vi.fn();
      const stream = createSessionStream({ sessionId: 'sess_1', onEvent });

      const payload = JSON.stringify(envelope({ seq: 5, data: { message: '多行' } }));
      // 在逗号之后断开：拼接符 `\n` 落在 JSON 允许的空白位置
      const splitAt = payload.indexOf(',') + 1;

      body.push(
        `id: ${STREAM_ID}\nevent: agent.message\n` +
          `data: ${payload.slice(0, splitAt)}\n` +
          `data: ${payload.slice(splitAt)}\n\n`,
      );

      await vi.waitFor(() => {
        expect(onEvent).toHaveBeenCalledTimes(1);
      });
      expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
        seq: 5,
        data: { message: '多行' },
      });

      stream.close();
    });

    it('注释行被忽略（心跳保活不该变成事件）', async () => {
      const body = streamingSseResponse();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));

      const onEvent = vi.fn();
      const stream = createSessionStream({ sessionId: 'sess_1', onEvent });

      // 冒号开头的整行注释：块级心跳、帧内注释，都不能被当成数据
      body.push(': keep-alive\n\n');
      body.push(
        `id: ${STREAM_ID}\nevent: agent.message\n` +
          ': 帧中间的注释行\n' +
          `data: ${JSON.stringify(envelope({ seq: 6, data: { message: '注释' } }))}\n\n`,
      );

      await vi.waitFor(() => {
        expect(onEvent).toHaveBeenCalledTimes(1);
      });
      expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
        seq: 6,
        data: { message: '注释' },
      });

      stream.close();
    });

    it('未知字段（retry 等）被忽略，不影响同一帧的派发', async () => {
      const body = streamingSseResponse();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));

      const onEvent = vi.fn();
      const stream = createSessionStream({ sessionId: 'sess_1', onEvent });

      // retry 刻意忽略：重连节奏由客户端退避序列决定，不让服务端改掉
      body.push(
        'retry: 3000\n' +
          'unknown-field: x\n' +
          `id: ${STREAM_ID}\n` +
          'event: agent.message\n' +
          `data: ${JSON.stringify(envelope({ seq: 7, data: { message: '未知字段' } }))}\n\n`,
      );

      await vi.waitFor(() => {
        expect(onEvent).toHaveBeenCalledTimes(1);
      });
      expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
        seq: 7,
        data: { message: '未知字段' },
      });

      stream.close();
    });

    it('CRLF 行结束符与 LF 等价（\\r 不参与行内容判定）', async () => {
      const body = streamingSseResponse();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));

      const onEvent = vi.fn();
      const stream = createSessionStream({ sessionId: 'sess_1', onEvent });

      /*
       * 不剥掉行尾 `\r` 的话，分隔帧的空行会变成 `"\r"` —— 它既非空行、
       * 也没有冒号，于是整帧永远不会被派发（不是「数据多一个 \r」这种小事）。
       */
      body.push(
        `id: ${STREAM_ID}\r\nevent: agent.message\r\n` +
          `data: ${JSON.stringify(envelope({ seq: 8, data: { message: '换行' } }))}\r\n\r\n`,
      );

      await vi.waitFor(() => {
        expect(onEvent).toHaveBeenCalledTimes(1);
      });
      expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
        seq: 8,
        data: { message: '换行' },
      });

      stream.close();
    });

    it('空 id: 不会清空续传游标（清了下次重连就退化成「无游标」）', async () => {
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
          envelope({ seq: 9, type: 'task.progress' }),
        )}\n\n` +
          // 空 id: 按规范会把「上一帧 id」重置为空；客户端刻意不照做 ——
          // 丢续传点的代价是断线期间的事件下一次重连再也补不回来
          `id:\nevent: task.progress\ndata: ${JSON.stringify(
            envelope({ seq: 10, type: 'task.progress' }),
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

    it('流在半帧处结束时丢弃残留，不派发不完整的事件', async () => {
      const body = streamingSseResponse();
      const fetchMock = vi.fn().mockResolvedValue(body.response);
      vi.stubGlobal('fetch', fetchMock);

      const onEvent = vi.fn();
      const stream = createSessionStream({
        sessionId: 'sess_1',
        onEvent,
        onError: () => undefined,
      });

      body.push(
        `id: ${STREAM_ID}\nevent: task.progress\ndata: ${JSON.stringify(
          envelope({ seq: 11, type: 'task.progress' }),
        )}\n\n`,
      );
      await vi.waitFor(() => {
        expect(onEvent).toHaveBeenCalledTimes(1);
      });

      /*
       * 半帧：JSON 完整，但缺结尾的空行 —— 服务端写到一半就断了。
       * 规范要求结束时丢弃残留（不能让一个没有被帧结束符确认的事件进界面）；
       * 它带的 `id:` 也因此不会被采纳，重连仍从上一帧的游标续传，
       * 服务端会把这一帧重新发一遍。
       */
      body.push(
        `id: 1757692800000-1\nevent: task.progress\ndata: ${JSON.stringify(
          envelope({ seq: 12, type: 'task.progress' }),
        )}`,
      );
      body.end();

      // 确定性信号：进入重连态说明读取循环已经退出、EOF 已处理完
      await vi.waitFor(() => {
        expect(stream.state).toBe('reconnecting');
      });
      expect(onEvent).toHaveBeenCalledTimes(1);

      stream.close();
    });
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

    /*
     * 先推一个数据块再等 open：建连阶段以**首个数据块**为终点
     * （否则「响应头已到、body 永不吐字节」的黑洞链路会被判成健康，
     * 见本文件后面的两条建连超时用例）。真实服务端建连后立刻发 `session.ready`。
     */
    body.push(': keep-alive\n\n');
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

  /*
   * ── 建连超时 ──
   *
   * `fetch` 自己没有超时。链路被黑洞（TCP 通、HTTP 不回包）时请求一直挂着，
   * 状态永远停在 `connecting`；而 `isEventStale()` 在「从未收到业务事件」时
   * 只认 open，于是界面**永久显示健康** —— 降级提示最该出现的场景反而最安静。
   * 下面两条把「超时必须发生」钉成确定性断言（推进假时钟，不真等 10 秒）。
   */
  it('建连被黑洞（TCP 通、HTTP 不回包）时超时失败并重连，不会永远停在 connecting', async () => {
    vi.useFakeTimers();

    /*
     * 黑洞链路的假 fetch：请求发出去了，但**永远不回包**。
     *
     * 不能用 `vi.fn(() => new Promise(() => undefined))` 一笔带过：
     * 那样连「超时确实中止了这次请求」都验证不了，而且收尾时若那个 promise
     * 变成 reject 就成了无人处理的拒绝。这里挂到 abort 信号上，
     * 忠实模拟浏览器语义：中止 → 以 AbortError 拒绝。
     */
    const hangingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('请求已中止', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', hangingFetch);

    const onError = vi.fn();
    const onStateChange = vi.fn();
    const stream = createSessionStream({
      sessionId: 'sess_1',
      onEvent: () => undefined,
      onError,
      onStateChange,
    });

    // 建连阶段：状态就是 connecting，且没有任何降级信号
    expect(stream.state).toBe('connecting');
    expect(stream.isEventStale()).toBe(false);

    // 差 1ms 都不该超时：慢网络也要给足建连时间
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stream.state).toBe('connecting');
    expect(onError).not.toHaveBeenCalled();

    // 到 10 秒：超时必须主动失败，走既有失败路径 → reconnecting
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.state).toBe('reconnecting');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('reconnecting');

    // 中止真的传下去了（否则这条请求会一直挂在浏览器连接池里）
    const [, init] = hangingFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);

    // 失败后按既有退避重连（第一次 1000ms），不是就此停摆
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hangingFetch).toHaveBeenCalledTimes(2);

    stream.close();
  });

  it('响应头已到但 body 永不吐字节时也按建连超时处理', async () => {
    vi.useFakeTimers();

    /*
     * 比整个请求不回包更隐蔽的一种黑洞：响应头正常返回（`fetch` 已经 resolve），
     * 但 body 一个字节都不给。只看「fetch 是否返回」的实现会在这里
     * 认定建连成功并把状态置为 open —— 界面随后显示健康，实际一个字都收不到。
     */
    const body = new ReadableStream<Uint8Array>({
      start() {
        // 刻意既不 enqueue 也不 close：挂在「已建连、无数据」上
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const onError = vi.fn();
    const stream = createSessionStream({
      sessionId: 'sess_1',
      onEvent: () => undefined,
      onError,
    });

    // 让 fetch 的 resolve 先落地：状态仍必须是 connecting（还没有任何数据）
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.state).toBe('connecting');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(stream.state).toBe('reconnecting');
    expect(onError).toHaveBeenCalledTimes(1);

    stream.close();
  });
});
