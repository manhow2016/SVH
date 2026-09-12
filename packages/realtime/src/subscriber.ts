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
 */
import { Redis } from 'ioredis';

import { DEFAULT_BLOCK_MS, eventStreamKey, READ_COUNT } from './keys.js';
import { parseRangeReply, parseStreamEntry, parseXreadReply } from './parse.js';
import {
  NOOP_REALTIME_LOGGER,
  type RealtimeLogger,
  type RedisConnectionOptions,
  type StreamedEvent,
} from './ports.js';

/** 订阅产出：一条事件，或「阻塞超时」——调用方据此发送心跳 */
export type RealtimeMessage = { kind: 'event'; event: StreamedEvent } | { kind: 'idle' };

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

      // 阻塞式命令独占连接，因此这里新建一条专用连接
      const redis = new Redis({ ...options.connection, maxRetriesPerRequest: null });
      redis.on('error', (err: Error) => {
        // 取消导致的断连是预期行为，不记为异常
        if (!signal.aborted) logger.warn('事件订阅连接异常', { error: err.message });
      });

      // 取消时直接断开连接：这会让挂起的 XREAD 立刻返回，无需等待阻塞超时
      const onAbort = (): void => {
        redis.disconnect();
      };
      signal.addEventListener('abort', onAbort);

      try {
        // ── 1. 补发缺失区间 ──
        // 用「包含起点再过滤」而不是排他语法 `(id`：后者需要 Redis 6.2+，
        // 前者在所有版本上都正确，代价只是多取一条记录。
        const rawBacklog = parseRangeReply(await redis.xrange(key, input.afterId, '+'));
        const backlog = rawBacklog.filter((entry) => entry[0] !== input.afterId);

        for (const entry of backlog) {
          if (signal.aborted) return;
          const event = parseStreamEntry(entry, input.sessionId);
          if (event !== null) yield { kind: 'event', event };
        }

        // ── 2. 实时推送 ──
        // 游标必须接续补发的最后一条，否则补发区间与实时区间之间会出现缝隙
        const lastBacklog = backlog.at(-1);
        let cursor = lastBacklog !== undefined ? lastBacklog[0] : input.afterId;

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
              await redis.xread(
                'COUNT',
                String(READ_COUNT),
                'BLOCK',
                String(blockMs),
                'STREAMS',
                key,
                cursor,
              ),
            );
          } catch (err) {
            // 取消触发的断连是预期行为，不算错误
            if (signal.aborted) return;
            logger.warn('读取事件流失败', {
              sessionId: input.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            // 不让一次读取失败终止整个订阅：退化为心跳后继续尝试
            yield { kind: 'idle' };
            continue;
          }

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
