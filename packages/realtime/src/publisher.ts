/**
 * 事件发布器
 *
 * ── 一条硬规则 ──
 * 发布失败**不得**向上抛异常。实时推送是增强能力，不是业务前置条件：
 * 用户的任务该成功还是要成功，不能因为 Redis 抖动就整体失败。
 * 因此这里捕获所有异常并只记日志。
 */
import { Redis } from 'ioredis';

import { eventSeqKey, eventStreamKey, STREAM_MAXLEN, STREAM_TTL_SECONDS } from './keys.js';
import {
  NOOP_REALTIME_LOGGER,
  type PublishInput,
  type PublishResult,
  type RealtimeLogger,
  type RedisConnectionOptions,
} from './ports.js';

/** 事件发布器 */
export interface EventPublisher {
  /** 发布一条事件。失败时返回 null（已记录日志），调用方无需处理异常。 */
  publish<T>(input: PublishInput<T>): Promise<PublishResult | null>;
  /** 释放连接 */
  close(): Promise<void>;
}

/** JSON 序列化；循环引用等异常情况退化为 'null' */
function serializeData(data: unknown): string {
  try {
    const text = JSON.stringify(data);
    return typeof text === 'string' ? text : 'null';
  } catch {
    return 'null';
  }
}

export function createEventPublisher(options: {
  connection: RedisConnectionOptions;
  logger?: RealtimeLogger;
}): EventPublisher {
  const logger = options.logger ?? NOOP_REALTIME_LOGGER;
  // maxRetriesPerRequest 收紧到 2：发布不该长时间挂着重试
  const redis = new Redis({ ...options.connection, maxRetriesPerRequest: 2 });

  // 必须挂 error 监听，否则连接异常会成为未处理的 error 事件导致进程退出
  redis.on('error', (err: Error) => {
    logger.warn('事件总线连接异常', { error: err.message });
  });

  return {
    async publish<T>(input: PublishInput<T>): Promise<PublishResult | null> {
      try {
        // seq 先自增再写入：即便随后 XADD 失败，也只是序号出现空洞，
        // 「会话内单调递增」这一契约仍然成立（空洞不影响单调性）。
        const seq = await redis.incr(eventSeqKey(input.sessionId));
        const at = new Date().toISOString();

        const streamId = await redis.xadd(
          eventStreamKey(input.sessionId),
          'MAXLEN',
          '~',
          String(STREAM_MAXLEN),
          '*',
          'type',
          input.type,
          'at',
          at,
          'sessionId',
          input.sessionId,
          'seq',
          String(seq),
          'data',
          serializeData(input.data),
        );

        if (streamId === null) return null;

        await redis.expire(eventStreamKey(input.sessionId), STREAM_TTL_SECONDS);

        return { streamId, seq, at };
      } catch (err) {
        logger.warn('事件发布失败（已忽略，不影响业务主流程）', {
          sessionId: input.sessionId,
          type: input.type,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    async close(): Promise<void> {
      try {
        await redis.quit();
      } catch {
        // quit 失败通常意味着连接已断，强制断开即可
        redis.disconnect();
      }
    },
  };
}
