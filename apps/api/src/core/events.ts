/**
 * API 侧的事件总线
 *
 * 与队列池一样采用**惰性单例**：进程内复用一个 Redis 连接，
 * 避免每个请求都新建连接。
 *
 * ── 为什么发布是「发射后不管」 ──
 * 实时推送是增强能力，不是业务前置条件。用户的任务该成功还是要成功，
 * 不能因为 Redis 抖动就整体失败。因此 publishSessionEvent 从不抛异常，
 * 失败只记日志。
 */
import { getEnv } from '@svh/config';
import type { SseEventType } from '@svh/domain';
import { parseRedisConnection } from '@svh/queue';
import { createEventPublisher, type EventPublisher, type PublishResult } from '@svh/realtime';

/** 发布器单例 */
let publisher: EventPublisher | null = null;

/** 取出（必要时创建）事件发布器 */
export function getEventPublisher(): EventPublisher {
  if (publisher === null) {
    publisher = createEventPublisher({
      connection: parseRedisConnection(getEnv().REDIS_URL),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (msg, meta) => console.warn(`[realtime] ${msg}`, meta ?? ''),
        error: (msg, meta) => console.error(`[realtime] ${msg}`, meta ?? ''),
      },
    });
  }
  return publisher;
}

/** 关闭事件连接（进程退出前调用） */
export async function closeEventPublisher(): Promise<void> {
  if (publisher !== null) {
    await publisher.close();
    publisher = null;
  }
}

/**
 * 发布一条会话事件。
 *
 * `sessionId` 为空时直接跳过 —— 没有会话归属的事件无法路由给任何人，
 * 这不是错误（例如直接经 POST /api/skills/:id/execute 创建的任务）。
 *
 * 除了 `publish` 自身的失败（返回 null），连接**建立**阶段也可能失败
 * （`getEnv()` 校验不通过、`parseRedisConnection` 解析失败、ioredis 构造抛错）。
 * 这里一并兜住：实时推送永远不能把业务请求带崩。
 */
export async function publishSessionEvent(
  sessionId: string | null | undefined,
  type: SseEventType,
  data: unknown,
): Promise<PublishResult | null> {
  if (sessionId === null || sessionId === undefined || sessionId.length === 0) return null;
  try {
    return await getEventPublisher().publish({ sessionId, type, data });
  } catch (err) {
    console.warn('[realtime] 事件发布器不可用（已忽略，不影响业务主流程）', err);
    return null;
  }
}
