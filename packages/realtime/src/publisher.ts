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

/**
 * 单条 Redis 命令的超时上界（毫秒）
 *
 * 只对「连接在但不回包」的形态生效：那种情况下 ioredis 不会触发重连，
 * 命令既不会成功也不会失败，没有这个上界调用方会无限期挂起。
 */
export const PUBLISH_COMMAND_TIMEOUT_MS = 500;

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
  /*
   * 连接参数里有两个**不同**的超时概念，别把它们混为一谈：
   *
   * - `maxRetriesPerRequest: 2` 只决定「连接断开后，命令在第几个冲刷边界被
   *   reject」，节拍由 retryStrategy 的重连退避决定。它是**重试频率**，
   *   不是时间上界 —— 实测断连期间一次发布要等约 3.4s 才失败。
   * - `commandTimeout: 500` 才是真正的硬上界：连接还在、但对端不回包
   *   （半开 TCP、Redis 被 STOP、网络分区）时，命令既不失败也不重连，
   *   没有它 `await` 会永远挂住。它同时兜住 close() 里的 quit。
   *
   * ── 这个硬上界带来的部署前提（详见 docs/ARCHITECTURE.md §6.9 运维说明）──
   * `commandTimeout` 是**连接级**的，ioredis 在握手阶段自己发出的就绪探测
   * （`INFO`）也在它的管辖内。于是 Redis 与应用之间的 RTT 必须显著小于 500ms：
   * 跨机房 / 跨地域（RTT 数百毫秒）会让连接永远进不了 `ready`，发布一律返回
   * null —— API 仍返回 200，但实时功能整段消失。因此 Redis 应与应用同机或
   * 同局域网部署；确需跨机房时，这个值须与实测 RTT 一起评估后同步调大。
   */
  const redis = new Redis({
    ...options.connection,
    maxRetriesPerRequest: 2,
    commandTimeout: PUBLISH_COMMAND_TIMEOUT_MS,
  });

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
