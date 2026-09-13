/**
 * SSE 客户端。
 *
 * ── 这个文件要解决的三个问题 ──
 *
 * **1. 断线不能静默。** 断线后按退避重连，并把连接状态暴露给界面，
 * 让界面显示降级提示条。用户必须知道当前进度可能不是最新的。
 *
 * **2. 降级判据必须锚定「事件陈旧度」，而不是「帧缺失」。**
 * 这是控制方在 Phase 5A 终审时定下的裁定：Phase 5A 给订阅连接加了
 * `blockingTimeout`，半开（对端不回包）的连接现在会**每 15 秒准时收到一次 `ping`**。
 * 如果按「多久没收到帧」判定断线，半开链路会看起来完全健康 ——
 * 而那恰恰是降级提示最该出现的场景。
 * 因此这里单独记录**最后一次业务事件**的时间，`isEventStale()` 只看它。
 *
 * **3. 建连阶段也必须会超时。** `fetch` 自己没有超时：链路被黑洞
 * （TCP 通、HTTP 不回包）时请求一直挂着，状态永远停在 `connecting`，
 * 而上面第 2 条的判据在「从未收到业务事件」时只认 `open` ——
 * 两条合起来就是**界面永久显示健康**。因此建连阶段带客户端超时，
 * 超时走既有失败路径（`reconnecting`），详见 `CONNECT_TIMEOUT_MS`。
 *
 * ── 续传游标：取自 SSE 帧的 `id:`，走 `Last-Event-ID` 请求头 ──
 * 服务端（apps/api/src/routes/events.ts）把 Redis Stream ID 写成 SSE 的 `id:`，
 * 断开重连时**只**从 `Last-Event-ID` 请求头读回续传点（没有任何查询参数分支）。
 * 游标值与信封里的 `seq` 是两回事：`seq` 是会话内序号，服务端认不出来。
 *
 * ── 默认传输层为什么是 fetch 而不是原生 EventSource ──
 * 原生 EventSource 不能自定义请求头，而它自己的自动重连又不受本文件的退避策略
 * 控制；更要命的是**新建实例不会继承上一个实例的游标**（游标是实例内部状态）。
 * 也就是说「自定义退避 + 请求头续传」用原生 EventSource 无法同时成立，
 * 而唯一可行的那种组合（close 后新建实例 + 游标放 URL）恰好就是会**静默丢事件**
 * 的那种。所以这里用 fetch + ReadableStream 自己解析 SSE 帧。
 */

/** 事件信封，与 @svh/domain 的 SseEnvelope 对齐 */
export interface SseEnvelope<T = unknown> {
  seq: number;
  type: string;
  at: string;
  sessionId: string;
  data: T;
}

/** 连接状态。界面据此显示降级提示。 */
export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SessionStream {
  /** 当前连接状态 */
  readonly state: StreamState;
  /**
   * 最后一次**业务**事件是否已陈旧。
   *
   * `ping` 与 `session.ready` 不刷新它 —— 它们是心跳，不代表有进展。
   */
  isEventStale(): boolean;
  /** 最后一次业务事件的到达时间（毫秒），从未收到则为 null */
  lastEventAt(): number | null;
  close(): void;
}

/** 连接的最小接口，便于测试注入假实现 */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  close(): void;
}

export interface StreamConnectionInit {
  /** 事件端点。游标不进 URL —— 它按协议走请求头 */
  url: string;
  /** 续传游标：上一帧的 SSE `id:`（Redis Stream ID）。首次连接为 null */
  lastEventId: string | null;
}

export type StreamConnectionFactory = (init: StreamConnectionInit) => EventSourceLike;

export interface SessionStreamOptions {
  sessionId: string;
  onEvent: (envelope: SseEnvelope) => void;
  onStateChange?: (state: StreamState) => void;
  /** 连接失败时的回调，用于把原因暴露给界面 */
  onError?: () => void;
  /** 注入点：测试传假连接；默认是下面的 fetch 实现 */
  createConnection?: StreamConnectionFactory;
  /** 注入点：测试控制时钟 */
  now?: () => number;
  /** 业务事件超过此时长未更新即视为陈旧 */
  staleAfterMs?: number;
}

/** 退避序列（毫秒）。到顶后保持，避免无限增长的等待。 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** 退避到顶后的间隔，与 BACKOFF_MS 最后一项一致 */
const MAX_BACKOFF_MS = 15_000;

/** 不算「业务事件」的类型：它们是心跳或建连确认，不代表有进展 */
const NON_BUSINESS_TYPES: ReadonlySet<string> = new Set(['ping', 'session.ready']);

/** 事件端点 */
function eventsUrl(sessionId: string): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/events`;
}

/**
 * 建连超时（毫秒）。
 *
 * ── 为什么必须有 ──
 * `fetch` 自己**没有**超时。链路被黑洞（TCP 通、HTTP 不回包）时，
 * 请求会一直挂着，连接状态也就永远停在 `connecting`：
 * 界面既不报断线也不报陈旧（`isEventStale()` 在从未收到业务事件时只认 `open`），
 * 于是**永久显示健康** —— 恰恰是降级提示最该出现的场景。
 *
 * 超时后不新增状态，直接走既有的失败路径：`onerror` → `reconnecting` → 退避重连，
 * 界面据此显示降级条。取 10 秒是因为它只影响「建连阶段」的感知延迟 ——
 * 正常建连是毫秒级，10 秒足够容纳慢网络，又不会让用户长时间盯着一个假的健康态。
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Redis Stream ID 的大小比较（`<ms>-<seq>`，也接受只有 `<ms>` 的形态）。
 *
 * 必须分段按数值比较：按字符串比会把 `"…-10"` 判成小于 `"…-9"`，
 * 正好判反需要拦住的那一类。无法解析时保守返回 false ——
 * 宁可不动游标，也不要把它回退到一个更旧的续传点。
 *
 * 这里没有复用 `@svh/realtime` 的同名函数：那是服务端代码，
 * 前端 bundle 不该被它拖进 Redis 依赖。
 */
function isStreamIdAfter(candidate: string, current: string): boolean {
  const parse = (id: string): [number, number] | null => {
    const parts = id.split('-');
    const ms = parts[0];
    const seq = parts[1];
    if (ms === undefined || !/^\d+$/.test(ms)) return null;
    if (seq === undefined) return [Number(ms), 0];
    if (parts.length > 2 || !/^\d+$/.test(seq)) return null;
    return [Number(ms), Number(seq)];
  };

  const left = parse(candidate);
  const right = parse(current);
  if (left === null || right === null) return false;

  const [leftMs, leftSeq] = left;
  const [rightMs, rightSeq] = right;
  if (leftMs !== rightMs) return leftMs > rightMs;
  return leftSeq > rightSeq;
}

/** 一帧解析结果 */
interface ParsedEvent {
  type: string;
  data: string;
  lastEventId: string;
}

/**
 * SSE 帧解析器（增量）。
 *
 * 只实现真正会用到的字段：`event:` / `data:` / `id:`，以及注释行（心跳）。
 * `retry:` 被刻意忽略 —— 重连节奏由上面的退避序列决定，不能让服务端改掉。
 *
 * 之所以按「行」增量解析、而不是按 `\n\n` 切分整帧：
 * 网络分片不会照顾帧边界，一条帧被切成两段是常态，
 * 按分隔符切会偶发丢事件 —— 正是最难查的那类缺陷。
 */
class SseFrameParser {
  private buffer = '';
  /** 上一帧的 id。SSE 规范里它会一直沿用，直到某帧显式给出新的 id */
  private lastEventId = '';
  private eventType = '';
  private dataLines: string[] = [];

  push(chunk: string): ParsedEvent[] {
    this.buffer += chunk;
    const events: ParsedEvent[] = [];

    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;

      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      // 协议里 CRLF 同样合法
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (line.length === 0) {
        const dispatched = this.dispatch();
        if (dispatched !== null) events.push(dispatched);
        continue;
      }

      // 以冒号开头的是注释行（心跳保活常用），忽略
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      // 规范：冒号后最多去掉一个空格
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') this.eventType = value;
      else if (field === 'data') this.dataLines.push(value);
      else if (field === 'id') this.lastEventId = value;
      // 其余字段（retry / 未知字段）一律忽略
    }

    return events;
  }

  private dispatch(): ParsedEvent | null {
    if (this.dataLines.length === 0) {
      // 没有 data 的帧不派发，但 `id:` 已经生效（规范如此）
      this.eventType = '';
      return null;
    }

    const event: ParsedEvent = {
      type: this.eventType.length > 0 ? this.eventType : 'message',
      data: this.dataLines.join('\n'),
      lastEventId: this.lastEventId,
    };
    this.eventType = '';
    this.dataLines = [];
    return event;
  }
}

/**
 * 默认传输层：用 fetch 读事件流。
 *
 * 与浏览器 EventSource 对齐的部分：`onopen` / `onerror` / `onmessage` 语义，
 * 以及 `message` 事件上的 `lastEventId`。唯一不同的是它**不自己重连** ——
 * 一次失败就交给上面的退避策略，避免两套重连逻辑互相打架。
 */
class FetchEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  private readonly controller = new AbortController();
  private closed = false;
  /** 建连超时定时器；建连完成或中止后必须清掉，见 finishConnecting */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否仍在「建连阶段」（尚未拿到可读的事件流） */
  private connecting = true;
  /** 已经报过失败：超时与随后的读取异常都会走到 fail()，只能报一次 */
  private failed = false;

  constructor(init: StreamConnectionInit) {
    /*
     * 用定时器 + AbortController 而不是 `AbortSignal.timeout`：
     * 后者无法在**建连成功后**撤销 —— 它会按绝对时限中止整条流，
     * 把一个已经很健康的长连接在 10 秒后掐断（事件流本来就该长期开着）。
     * 这里要的是「建连超时」，不是「连接寿命上限」。
     */
    this.connectTimer = setTimeout(() => {
      /*
       * abort 会让在途的 fetch 立刻抛错（最常见的情形），
       * 但**不能只靠它**：读取循环若正挂在首次 `reader.read()` 上，
       * 中止能否打断它取决于底层实现。这里直接补一次失败上报，
       * 保证超时一定走到 reconnecting，而不是把状态留在 connecting 上。
       */
      this.controller.abort();
      this.fail();
    }, CONNECT_TIMEOUT_MS);

    void this.run(init);
  }

  close(): void {
    this.closed = true;
    this.finishConnecting();
    this.controller.abort();
  }

  /** 建连阶段结束：撤掉超时定时器（它只该管到「拿到可读的事件流」为止） */
  private finishConnecting(): void {
    this.connecting = false;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private async run(init: StreamConnectionInit): Promise<void> {
    let response: Response;
    try {
      response = await fetch(init.url, {
        method: 'GET',
        // 事件流一旦被缓存，界面就会停在过去
        cache: 'no-store',
        // 续传游标按协议放请求头：服务端只认这个（见文件头说明）
        headers: init.lastEventId === null ? {} : { 'Last-Event-ID': init.lastEventId },
        signal: this.controller.signal,
      });
    } catch {
      // 请求根本没发出去（断网 / 中止 / 建连超时）
      this.fail();
      return;
    }

    if (this.closed) return;

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || response.body === null || !contentType.includes('text/event-stream')) {
      // 不是事件流（网关的 HTML 错误页、代理的 JSON 等）：
      // 当成一次失败，交给退避重连，而不是安静地什么都不做
      this.fail();
      return;
    }

    const reader = response.body.getReader();

    /*
     * 建连阶段要一直管到**首个数据块到达**为止，不能只看 fetch 是否返回。
     * 「响应头已回、body 却永不吐字节」同样是黑洞链路：状态会停在 connecting，
     * 而界面依旧显示健康。
     *
     * 因此 `onopen`（即 `state === 'open'`）的语义在这里被收紧为
     * 「响应头合法 **且** 对端已开始说话」—— 首个数据块就是「对端真的在说话」
     * 的第一个可观测证据。服务端建连后立刻发 `session.ready`（见
     * apps/api/src/routes/events.ts），所以正常链路的 open 依旧是毫秒级，
     * 不会因这次收紧而变慢。
     */
    let firstChunk: ReadableStreamReadResult<Uint8Array>;
    try {
      firstChunk = await reader.read();
    } catch {
      this.fail();
      return;
    }

    this.finishConnecting();
    if (this.closed) return;

    this.onopen?.(new Event('open'));

    const decoder = new TextDecoder();
    const parser = new SseFrameParser();

    try {
      let chunk: ReadableStreamReadResult<Uint8Array> | null = firstChunk;
      while (chunk !== null) {
        if (chunk.done) break;

        for (const parsed of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          this.onmessage?.(
            new MessageEvent(parsed.type, {
              data: parsed.data,
              lastEventId: parsed.lastEventId,
            }),
          );
        }

        chunk = await reader.read();
      }
    } catch {
      // close() 触发的中止与网络中断都走这里，统一在下面按 closed 判定
    }

    // 流结束同样是断线：不报的话界面会一直停在「连接正常」上
    this.fail();
  }

  private fail(): void {
    // 只有建连阶段才需要撤定时器；已连上时它早就被清掉了
    if (this.connecting) this.finishConnecting();
    if (this.failed) return;
    this.failed = true;
    if (this.closed) return;
    this.onerror?.(new Event('error'));
  }
}

function createFetchConnection(init: StreamConnectionInit): EventSourceLike {
  return new FetchEventSource(init);
}

export function createSessionStream(options: SessionStreamOptions): SessionStream {
  const {
    sessionId,
    onEvent,
    onStateChange,
    onError,
    createConnection = createFetchConnection,
    now = () => Date.now(),
    staleAfterMs = 45_000,
  } = options;

  /*
   * 建连时刻。
   *
   * 它是 `isEventStale()` 在「从未收到业务事件」时的锚点：没有它，
   * 建连瞬间就会把「还没收到任何事件」误判成「事件陈旧」，
   * 页面一进来就挂一条降级提示。
   */
  const startedAt = now();
  const url = eventsUrl(sessionId);

  let state: StreamState = 'connecting';
  let lastEventAt: number | null = null;
  let lastEventId: string | null = null;
  let attempt = 0;
  let closed = false;
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: StreamState): void {
    if (state === next) return;
    state = next;
    onStateChange?.(next);
  }

  /** 断开当前连接并摘掉监听：回调不该再打到一条已经作废的连接上 */
  function detach(): void {
    const current = source;
    if (current === null) return;
    source = null;
    current.onopen = null;
    current.onerror = null;
    current.onmessage = null;
    current.close();
  }

  function connect(): void {
    if (closed) return;

    reconnectTimer = null;
    const created = createConnection({ url, lastEventId });
    source = created;

    created.onopen = (): void => {
      if (closed) return;
      // 连上了就把退避计数清零：下一次断线仍从最短间隔开始
      attempt = 0;
      setState('open');
    };

    created.onmessage = (event: MessageEvent<string>): void => {
      if (closed) return;

      let envelope: SseEnvelope;
      try {
        envelope = JSON.parse(event.data) as SseEnvelope;
      } catch {
        // 单条坏数据不该打断整条推送链路
        return;
      }

      /*
       * 只有业务事件才刷新时间戳。
       *
       * ping 与 session.ready 是心跳 / 建连确认，不代表有进展。
       * 半开连接会每 15s 准时收到一次 ping —— 靠它刷新就等于把降级判据废掉，
       * 而那正是降级提示最该出现的场景。
       */
      if (!NON_BUSINESS_TYPES.has(envelope.type)) {
        lastEventAt = now();
      }

      /*
       * 续传游标取自 SSE 帧的 `id:`（Redis Stream ID），**不是**信封里的 seq。
       *
       * 除下面那条例外，只前进不回退：乱序或重复送达的旧帧不能把续传点拉回去，
       * 否则那一段事件会被重复补发，更糟的是可能停在更旧的锚点上。
       * 心跳与「客户端游标有效时的 session.ready」不带 id，服务端刻意如此 ——
       * 此时 MessageEvent.lastEventId 沿用上一帧的值，游标原地不动。
       *
       * ── 例外：带 `id:` 的 session.ready 必须**无条件采纳** ──
       * 服务端只在「客户端游标缺失 / 非法 / **合法但超前**」时给 ready 帧写 `id:`，
       * 那正是本次连接新产生的基准游标，写出来就是为了把客户端手里那个超前的
       * 游标拉回正确位置（Redis 时钟回拨、VM 快照恢复后，旧游标会大于新基准 ID；
       * 契约见 apps/api/src/routes/events.ts 的 parseLastEventId，以及
       * apps/api/test/sse.test.ts 的「Last-Event-ID 合法但超前时回退」用例）。
       * 这里若对 ready 帧同样套用前向守卫，这次回退会被**拒掉**：游标永久停在
       * 超前值上，之后每次重连都被服务端判为「无游标」而只订阅新事件 ——
       * 断线期间的事件每次静默丢失，正是本文件要消灭的那类缺陷。
       *
       * 空白 `id:` 仍然不动游标（见下面的 length 判断）：游标被清空同样会让
       * 下一次重连退化成「无游标」，宁可停在原处也不要丢续传点。
       */
      const frameId = event.lastEventId;
      if (frameId.length > 0) {
        const isReadyFrame = envelope.type === 'session.ready';
        if (isReadyFrame || lastEventId === null || isStreamIdAfter(frameId, lastEventId)) {
          lastEventId = frameId;
        }
      }

      onEvent(envelope);
    };

    created.onerror = (): void => {
      if (closed) return;

      // 自己接管重连，因此先把这条连接彻底作废
      detach();
      setState('reconnecting');
      onError?.();

      /*
       * 先撤掉上一次排好的重连。
       *
       * 正常实现里 `detach()` 已经把回调摘干净，`onerror` 只可能来一次；
       * 但这是**注入的连接实现**（见文件头：真机用 fetch 流，测试用假实现），
       * 违约连发两次 `onerror` 时旧写法会把 `reconnectTimer` 覆盖掉：
       * 第一条定时器变成孤儿，到点后自己发起一次连接 ——
       * 结果是两条并行连接各自重连，事件重复、退避计数也被打乱。
       */
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);

      // 退避到顶后保持：指数增长会让恢复时间变得不可接受
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? MAX_BACKOFF_MS;
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
  }

  connect();

  return {
    get state() {
      return state;
    },
    isEventStale() {
      if (lastEventAt === null) {
        /*
         * 从未收到业务事件：以建连时刻为锚，且只在 open 状态下判定。
         *
         * 为什么必须限定 open：`reconnecting` 本身就是更明确的降级信号，
         * 界面据此已经会提示；这里再多报一次「陈旧」只会让提示自相矛盾，
         * 也会让建连瞬间的页面闪一下降级条。
         *
         * ── 那 `connecting` 靠什么兜底 ──
         * 不靠这里，靠**建连超时**：黑洞链路（TCP 通、HTTP 不回包）会停在
         * connecting 并永远收不到业务事件，只判 open 的话界面会永久显示健康。
         * 因此传输层在 CONNECT_TIMEOUT_MS 后主动中止并走失败路径
         * （onerror → reconnecting），降级提示照常出现。
         * 判定与兜底是两件事，缺一不可。
         */
        return state === 'open' && now() - startedAt > staleAfterMs;
      }
      return now() - lastEventAt > staleAfterMs;
    },
    lastEventAt() {
      return lastEventAt;
    },
    close() {
      if (closed) return;
      closed = true;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // 同时摘掉监听并关闭底层连接（fetch 版会 abort 掉在途请求）
      detach();
      setState('closed');
    },
  };
}
