/**
 * 实时事件总线的端口定义
 *
 * 本包只依赖**接口**：连接参数与日志器都由调用方注入。
 * 这样 API 与 Worker 可以各自决定如何取得配置与如何记录日志。
 */
import type { SseEventType } from '@svh/domain';

/**
 * Redis 连接参数。
 *
 * 刻意与 `@svh/queue` 的 `parseRedisConnection` 返回结构保持兼容，
 * 因此调用方可以直接把它传进来，无需转换。
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
}

/** 结构化日志接口（与 @svh/skills 的约定一致） */
export interface RealtimeLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** 空日志器，用于测试与未注入日志器的场景 */
export const NOOP_REALTIME_LOGGER: RealtimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 待发布事件。seq 与 at 由发布器补齐，调用方不关心。 */
export interface PublishInput<T = unknown> {
  sessionId: string;
  type: SseEventType;
  data: T;
}

/** 发布结果 */
export interface PublishResult {
  /** Redis Stream ID，作为 SSE 的 id: 字段供 Last-Event-ID 断点续传 */
  streamId: string;
  /** 会话内单调递增序号，对应契约的 SseEnvelope.seq */
  seq: number;
  /** 产生时间（ISO 8601） */
  at: string;
}

/** 从流中读出的事件 */
export interface StreamedEvent {
  streamId: string;
  seq: number;
  type: SseEventType;
  at: string;
  /** 归属会话。以**订阅方声明的会话**为准，不信任流内字段。 */
  sessionId: string;
  data: unknown;
}
