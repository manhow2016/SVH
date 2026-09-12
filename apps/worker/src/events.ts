/**
 * Worker 侧的事件汇聚器
 *
 * ── 为什么是同步的 emit ──
 * 任务的执行路径绝不能因为 Redis 抖动而变慢或失败。因此 `emit` 同步返回，
 * 内部「发射后不管」；`publish` 自身已吞掉所有异常且永不 reject，
 * 连接选项里也内置了 `commandTimeout`，发布不会无限挂起。
 *
 * ── 为什么没有会话归属就跳过 ──
 * 直接经 `POST /api/skills/:id/execute` 创建的任务没有 sessionId，
 * 没有会话归属的事件无法路由给任何人。这不是错误，只是无处可推。
 */
import type { SseEventType } from '@svh/domain';
import type { EventPublisher } from '@svh/realtime';

/** 事件汇聚端口 */
export interface EventSink {
  /** 发射一条事件。同步返回，永不抛异常。 */
  emit(input: {
    sessionId: string | null | undefined;
    type: SseEventType;
    data: unknown;
  }): void;
}

/** 空实现：未接入事件总线时使用（例如单元测试） */
export const NOOP_EVENT_SINK: EventSink = {
  emit: () => undefined,
};

/** 用真实发布器构造汇聚器 */
export function createEventSink(publisher: EventPublisher): EventSink {
  return {
    emit(input) {
      const { sessionId } = input;
      if (sessionId === null || sessionId === undefined || sessionId.length === 0) return;

      try {
        // publish 内部已捕获全部异常，这里再包一层是为了防御
        // 「publish 实现被替换成会同步抛异常的版本」这种情形。
        void publisher.publish({ sessionId, type: input.type, data: input.data });
      } catch {
        // 事件推送失败不应影响任务执行
      }
    },
  };
}
