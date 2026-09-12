/**
 * 工作台与 SSE 协议之间的翻译层。
 *
 * ── 为什么单独成文件 ──
 * 这些是**纯函数**：把网络上下来的 `unknown` 收窄成界面能安全使用的形状，
 * 以及「事件类型 → 语义」的映射。真正的分派留在 `AgentWorkspace`
 * （它需要组件状态：消息列表、任务刷新信号、结果卡去重集合）。
 *
 * ── 为什么事件类型清单是手写的 ──
 * 前端不引 `@svh/domain`（那会把服务端代码拉进 bundle），
 * 因此这份清单与 `packages/domain/src/transport.ts` 的 `SSE_EVENT_TYPES` 手动对齐。
 * 协议新增类型时这里会落后，而落后的表现是「未知事件只记一条 warn」——
 * 这正是我们要的：不静默，但也不因为多出一个事件类型就崩掉整条流。
 */
import type { SessionMessage } from '../../lib/api-types.js';

/** 前端认识的 SSE 事件类型（与 @svh/domain 的 SSE_EVENT_TYPES 对齐） */
export const KNOWN_EVENT_TYPES = [
  /** 会话建立确认，携带最新事件 id（供断线重连断点续传） */
  'session.ready',
  /** Agent 文本消息增量 */
  'agent.message',
  /** 制作计划（Plan Protocol） */
  'agent.plan',
  /** 结构化结果卡片 */
  'agent.result_card',
  /** 需要用户确认 */
  'agent.confirmation',
  /** Agent 状态机变化 */
  'agent.state',
  /** 任务状态变化 */
  'task.status',
  /** 任务进度 */
  'task.progress',
  /** 资产创建 / 更新 */
  'asset.changed',
  /** 内容更新 */
  'content.changed',
  /** 工作流运行推进 */
  'workflow.advanced',
  /** 面向用户的错误 */
  'error',
  /** 心跳，用于保持连接与检测断线 */
  'ping',
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

/** 事件类型是否是前端认识的那几种 */
export function isKnownEventType(type: string): type is KnownEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * 携带结构化载荷的事件 → 该载荷对应的消息 kind。
 *
 * 不携带载荷的事件返回 null。kind 与载荷的 `type` 一致 ——
 * 服务端记历史时也是这么落库的（见 apps/api/src/routes/agent.ts 的 appendMessage），
 * 两边口径一致，刷新前后同一条消息的渲染方式才不会变。
 */
export function payloadKindOf(type: KnownEventType): SessionMessage['kind'] | null {
  switch (type) {
    case 'agent.plan':
      return 'plan';
    case 'agent.confirmation':
      return 'confirmation_request';
    case 'agent.result_card':
      return 'result_card';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

/** 是不是一个可以按字段读取的对象（用来收窄 unknown） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 从事件载荷里安全读出一个非空字符串字段；结构不符返回 null */
export function readTextField(data: unknown, key: string): string | null {
  if (!isRecord(data)) return null;
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 从任务详情里取出结果卡。
 *
 * 技能把结果卡放在 `output.card`（见 apps/worker/src/runner.ts 的 handleSuccess），
 * 形状与对话流里的 `result_card` 载荷一致，因此这里只校验「有没有 card」与
 * 「它的 type 是不是 result_card」—— 元素级校验交给消息渲染链上的
 * `withArrayDefaults` 与 `MessageBoundary`，不在前端复刻一份 schema。
 *
 * 返回的是收窄后的对象而不是 `ResultCardPayload`：这里的校验强度撑不起那个类型
 * （只看了 type 一个字段），写成断言等于用类型撒谎。
 */
export function resultCardOf(output: unknown): Record<string, unknown> | null {
  if (!isRecord(output)) return null;
  const card = output.card;
  if (!isRecord(card)) return null;
  return card.type === 'result_card' ? card : null;
}

/**
 * 编译期穷尽检查。
 *
 * 参数类型是 `never`：`KnownEventType` 新增一个事件类型、而分派链上漏掉它的
 * `default` 分支就会**编译报错**，而不是等到线上才发现某类事件没人处理。
 * 运行时什么都不做 —— 未知类型在进入分派前就被 `isKnownEventType` 挡下并记了警告。
 */
export function exhaustive(value: never): void {
  void value;
}
