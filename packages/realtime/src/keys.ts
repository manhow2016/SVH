/**
 * 实时事件总线的 Redis Key 约定
 *
 * 所有键统一以 `svh:` 开头，与 @svh/queue 的 BullMQ 前缀保持一致，
 * 避免与同一 Redis 库中的其它项目冲突。
 *
 * ── 为什么以「会话」而不是「项目」为通道 ──
 * 传输契约（packages/domain/src/transport.ts）把 sessionId 定为强制字段，
 * 并要求服务端按会话过滤。以会话为键，跨会话泄漏在**结构上**不可能发生，
 * 而不是依赖查询条件写对。
 */

/** 键前缀 */
const PREFIX = 'svh';

/** 会话事件流（Redis Stream）。每个会话一条流。 */
export function eventStreamKey(sessionId: string): string {
  return `${PREFIX}:events:session:${sessionId}`;
}

/**
 * 会话事件序号计数器。
 *
 * 领域契约 SseEnvelope.seq 要求**会话内单调递增整数**，而 Redis Stream ID
 * 形如 `1700000000000-0`。两者用途不同：seq 供前端排序与展示，
 * Stream ID 作为 SSE 的 `id:` 字段供 Last-Event-ID 断点续传。
 */
export function eventSeqKey(sessionId: string): string {
  return `${PREFIX}:seq:${sessionId}`;
}

/** 事件流最大长度（近似）。超出后由 Redis 裁剪，防止无限增长。 */
export const STREAM_MAXLEN = 2000;

/** 事件流存活时间（秒）。会话长期不活跃后自动回收。 */
export const STREAM_TTL_SECONDS = 86_400;

/** XREAD 阻塞时长（毫秒）。超时后调用方发送心跳，用于探测断线。 */
export const DEFAULT_BLOCK_MS = 15_000;

/** 单次 XREAD 最多取出的事件数 */
export const READ_COUNT = 50;
