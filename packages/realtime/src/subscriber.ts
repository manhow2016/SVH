/**
 * 事件订阅器
 *
 * ── 这个文件解决的是一个具体的严重缺陷 ──
 * 参考项目（见 docs/ARCHITECTURE_AUDIT_REFERENCE.md 审计结论 ⑫）的 SSE
 * 在断线重连后永久静默：根因是「先 replay、再 subscribe」之间存在空窗，
 * 空窗期产生的事件既不在 replay 结果里，也没被订阅捕获。
 *
 * 这里的做法是把「补发」与「实时」放在**同一个游标**上：
 * 先 XRANGE 补发 afterId 之后的记录，拿到最后一条的 id 作为游标，
 * 紧接着用该游标 XREAD BLOCK。因为 XREAD 的语义是「返回 id 严格大于游标的
 * 记录」，两次调用之间不存在任何缝隙。
 *
 * ── 连接管理 ──
 * XREAD BLOCK 会独占连接，因此每次订阅使用独立 Redis 连接；
 * 取消时直接断开该连接，可立即解除阻塞，无需等待超时。
 *
 * 连接上另配了 `blockingTimeout`（略大于 blockMs）。取消是「本端主动」的解除
 * 手段，而 TCP 半开 / Redis 被 STOP / 网络分区这类「对端不回包」的形态
 * **没有任何 close 事件可依赖**（socket 还是 ESTABLISHED，ioredis 不重连、
 * 命令不 reject）：只能靠客户端的阻塞超时让 XREAD 有界返回。
 */
import { Redis } from 'ioredis';

import { DEFAULT_BLOCK_MS, eventStreamKey, READ_COUNT } from './keys.js';
import {
  parseRangeReply,
  parseStreamEntry,
  parseXreadReply,
  type RawStreamEntry,
} from './parse.js';
import {
  NOOP_REALTIME_LOGGER,
  type RealtimeLogger,
  type RedisConnectionOptions,
  type StreamedEvent,
} from './ports.js';

/** 订阅产出：一条事件，或「阻塞超时」——调用方据此发送心跳 */
export type RealtimeMessage = { kind: 'event'; event: StreamedEvent } | { kind: 'idle' };

/**
 * 实时阶段「有界降级」阈值：同一游标上连续读取失败达到该次数，即判为
 * **游标不可恢复**并结束订阅。
 *
 * 取 3 的理由：
 * - **下界**：瞬时抖动（Redis 慢、主从切换、短暂闪断）通常一两次重试内恢复，
 *   给到 3 次才有冗余，不会因为一次抖动就掐断客户端的实时连接；
 * - **上界**：永久性错误（游标 id 语法非法、键不是 Stream、键被改类型、
 *   ACL 被收回）会让**每一次** XREAD 都以命令级错误立即返回（ioredis 对
 *   error reply 只 reject 该命令、不触发重连），3 次即可在毫秒级识别，
 *   避免「连接被占住、零事件、日志无界增长」的空转；
 * - 判据是「连续失败」∧「游标无进展」，任何一次成功读取都会清零计数
 *   （见下方实时循环），因此长命订阅不会被历史上零星的抖动累积计数而误杀。
 */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

/**
 * 阻塞读的**客户端兜底超时**余量（毫秒），加在 `blockMs` 之上。
 *
 * ioredis 只在连接选项里配了正的 `blockingTimeout` 时才给阻塞命令装客户端定时器
 * （`Redis.sendCommand` 的 opt-in 开关，`BLOCKING_COMMANDS` 含 `xread`）——
 * 不配就完全没有兜底；配了之后定时器到点会让命令 `resolve(null)`，
 * 效果等同于「Redis 自己的 BLOCK 超时返回空」。
 *
 * 为什么必须有：`XREAD BLOCK` 在「连接还在、但对端不回包」时**永不结算** ——
 * 既不产出事件、也不产出 idle（因此没有 ping）、也不结束订阅，连接被一直占住。
 * 设计文档 §7.4 要求的「显示降级提示 + 回退轮询」恰恰在最需要它的场景下
 * 没有任何触发信号。
 *
 * 取值：比 `blockMs` 大 5s 的余量。正常路径永远由 Redis 自己的 BLOCK 超时先返回
 * （ioredis 对带 BLOCK 参数的 xread 会额外加 100ms 宽限；对离线队列里的阻塞命令
 * 则直接采用本选项的值），只有上述半开形态才会走到这个定时器。余量太小会在网络
 * 抖动时把健康订阅误判成空闲，太大则让降级提示迟到 —— 5s 相对 15s 的默认
 * `blockMs` 是两者之间的折中。
 */
const BLOCKING_TIMEOUT_GRACE_MS = 5000;

/** 订阅参数 */
export interface SubscribeOptions {
  sessionId: string;
  /**
   * 从该 Stream ID **之后**开始补发，随后自动转入实时推送。
   *
   * 必填：SSE 路由在建立连接时必定已持有基准 id
   * （新建连接的 `session.ready` id，或重连时客户端的 Last-Event-ID）。
   */
  afterId: string;
  /** 阻塞时长，超时产出 idle；测试可调小 */
  blockMs?: number;
  /** 取消信号。触发后立即结束订阅 */
  signal: AbortSignal;
}

/** 事件订阅器 */
export interface EventSubscriber {
  /**
   * 订阅会话事件。先补发 `afterId` 之后的记录，再转入实时推送。
   *
   * 每个订阅自持一条 Redis 连接，并在结束时释放，
   * 因此不需要额外的 close()。
   */
  subscribe(options: SubscribeOptions): AsyncGenerator<RealtimeMessage>;
}

export function createEventStream(options: {
  connection: RedisConnectionOptions;
  logger?: RealtimeLogger;
}): EventSubscriber {
  const logger = options.logger ?? NOOP_REALTIME_LOGGER;

  return {
    async *subscribe(input: SubscribeOptions): AsyncGenerator<RealtimeMessage> {
      const key = eventStreamKey(input.sessionId);
      const blockMs = input.blockMs ?? DEFAULT_BLOCK_MS;
      const { signal } = input;

      // 已取消的订阅直接结束：既不必建连，更不该发出一条 XRANGE
      if (signal.aborted) return;

      // 阻塞式命令独占连接，因此这里新建一条专用连接
      const redis = new Redis({
        ...options.connection,
        maxRetriesPerRequest: null,
        /*
         * 阻塞读的客户端兜底超时（ioredis 的 opt-in 选项）。少了它，
         * 对端不回包时 XREAD 永久挂起 —— 零事件、零 idle、零 ping，
         * 订阅既不产出也不结束。配上之后阻塞读有界返回 null，
         * 被 parseXreadReply 解析成空回复 → 产出 idle → 路由发送 ping。
         */
        blockingTimeout: blockMs + BLOCKING_TIMEOUT_GRACE_MS,
      });
      redis.on('error', (err: Error) => {
        // 取消导致的断连是预期行为，不记为异常
        if (!signal.aborted) logger.warn('事件订阅连接异常', { error: err.message });
      });

      /*
       * 取消哨兵：与下面两处等待竞速。
       *
       * 只靠 `disconnect()` 并不足以解除挂起 —— 当 ioredis 处于「重连中」状态时
       * （Redis 未启动 → ECONNREFUSED → 定时重连），底层 socket 已经销毁，
       * `disconnect()` 不会再触发 close，挂在离线队列里的命令永远不会被拒绝，
       * 订阅及其 `for await` 消费方就会**永远挂住**，取消形同虚设。
       * 哨兵不依赖 ioredis 的内部状态，保证取消总能立刻结束迭代。
       */
      let rejectOnAbort: (err: Error) => void = () => undefined;
      const abortSentinel = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = reject;
      });

      // 取消时直接断开连接：这会让挂起的 XREAD 立刻返回，无需等待阻塞超时
      const onAbort = (): void => {
        redis.disconnect();
        rejectOnAbort(new Error('订阅已取消'));
      };
      signal.addEventListener('abort', onAbort);

      try {
        // ── 1. 补发缺失区间 ──
        // 用「包含起点再过滤」而不是排他语法 `(id`：后者需要 Redis 6.2+，
        // 前者在所有版本上都正确，代价只是多取一条记录。
        let backlog: RawStreamEntry[] = [];
        try {
          const rawBacklog = parseRangeReply(
            await Promise.race([redis.xrange(key, input.afterId, '+'), abortSentinel]),
          );
          backlog = rawBacklog.filter((entry) => entry[0] !== input.afterId);
        } catch (err) {
          // 取消触发的断连是预期行为，不算错误：此时 XRANGE 会以
          // `Connection is closed.`（或取消哨兵）被拒绝，必须在这里干净结束，
          // 否则异常会穿过生成器，让消费方的 `for await` 收到一个异常而不是迭代结束
          if (signal.aborted) return;
          /*
           * 补发失败**降级为纯实时**，不上抛。
           *
           * 实时阶段的初始游标同样取自 afterId（补发为空时回退到它），
           * 而 XREAD 会立即返回 id 严格大于该游标的全部既有记录 ——
           * 与 XRANGE 覆盖的是同一个区间，所以补发失败不会丢事件。
           * 上抛反而会让客户端因为一次瞬时抖动（Redis 慢/不可达、
           * Last-Event-ID 被篡改）而断连，与「实时推送是增强能力」相悖。
           */
          logger.warn('补发事件流失败，降级为纯实时订阅', {
            sessionId: input.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        for (const entry of backlog) {
          if (signal.aborted) return;
          const event = parseStreamEntry(entry, input.sessionId);
          if (event !== null) yield { kind: 'event', event };
        }

        // ── 2. 实时推送 ──
        // 游标必须接续补发的最后一条，否则补发区间与实时区间之间会出现缝隙
        const lastBacklog = backlog.at(-1);
        let cursor = lastBacklog !== undefined ? lastBacklog[0] : input.afterId;

        /*
         * 「连续失败」计数：只在读取失败时累加，成功读取时清零。
         *
         * 之所以能同时充当「游标无进展」的判据：游标**只在成功读到 entries 时**
         * 才前推，而那一刻计数已被清零；反过来，只要计数在累加，说明这几次失败
         * 之间从未有过成功读取，游标自然一步未动。两个条件的合取因此由计数本身
         * 保证，不需要再存一份「上次失败时的游标」。
         *
         * 注意空回复（BLOCK 超时、无新事件）同样算**成功**：安静会话里游标本来
         * 就长期不前进，若不在这里清零，几次相隔数小时的抖动会被累积成「连续失败」，
         * 把一条健康的订阅误杀。
         */
        let consecutiveReadFailures = 0;

        while (!signal.aborted) {
          let entries;
          try {
            /*
             * 参数顺序为 `COUNT n BLOCK ms STREAMS key id`。
             *
             * 这是 Redis 文档给出的顺序，也是 ioredis 类型定义中唯一提供的
             * 「带 COUNT 的阻塞读」重载。简报里的 `BLOCK ... COUNT ...` 在运行时
             * 同样合法（Redis 在遇到 STREAMS 之前不区分 BLOCK 与 COUNT 的先后），
             * 但 ioredis@5.11.1 的 xread 重载没有这一顺序，tsc 会报
             * TS2769「没有与此调用匹配的重载」。语义完全一致，只是实参次序不同。
             */
            entries = parseXreadReply(
              await Promise.race([
                redis.xread(
                  'COUNT',
                  String(READ_COUNT),
                  'BLOCK',
                  String(blockMs),
                  'STREAMS',
                  key,
                  cursor,
                ),
                abortSentinel,
              ]),
            );
          } catch (err) {
            // 取消触发的断连是预期行为，不算错误
            if (signal.aborted) return;

            consecutiveReadFailures += 1;
            const failure = {
              sessionId: input.sessionId,
              cursor,
              failures: consecutiveReadFailures,
              error: err instanceof Error ? err.message : String(err),
            };

            /*
             * 有界降级：瞬时故障退化为心跳后继续重试即可自愈，
             * 但「游标不可恢复」的永久性错误下重试永远不会成功 ——
             * 此时继续 yield idle 只会让订阅**既不产出事件也不结束**，
             * 日志无界增长、连接被一直占住，所以记 error 后干净结束。
             */
            if (consecutiveReadFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
              logger.error('事件流游标不可恢复，结束订阅', failure);
              return;
            }

            logger.warn('读取事件流失败', failure);
            // 不让一次读取失败终止整个订阅：退化为心跳后继续尝试
            yield { kind: 'idle' };
            continue;
          }

          // 读取成功即视为链路可用：清零连续失败计数（空回复也算成功）
          consecutiveReadFailures = 0;

          if (entries.length === 0) {
            yield { kind: 'idle' };
            continue;
          }

          for (const entry of entries) {
            cursor = entry[0];
            const event = parseStreamEntry(entry, input.sessionId);
            if (event !== null) yield { kind: 'event', event };
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        redis.disconnect();
      }
    },
  };
}
