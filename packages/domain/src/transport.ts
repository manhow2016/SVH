/**
 * 传输层契约（API 响应形状）
 *
 * ── 审计结论 ⑤：不要用「HTTP 200 + {code,data,message}」包打天下 ──
 * 参考项目用统一的 `ApiResponse<T>` 包装所有响应，后果是 SSE、流式响应
 * 与 RESTful 语义三者无法统一（分页、204、201、条件请求全部失真）。
 *
 * SVH 的明确决策：
 * - **成功**：直接返回资源本身，用 HTTP 状态码表达语义（200 / 201 / 204）；
 * - **失败**：用 4xx/5xx + `{ error: { code, message, suggestions, retryable } }`；
 * - **列表**：返回 `{ items, total, page, pageSize, hasMore }`；
 * - **实时推送**：使用独立的 SSE 事件协议（见 realtime.ts）。
 *
 * 因此这里**不存在**统一的 ApiResponse 包装类型 —— 这是刻意的设计。
 */
import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

/** 错误响应体 */
export const apiErrorBodySchema = z.object({
  error: z.object({
    /** 机器可读错误码 */
    code: z.enum(ERROR_CODES),
    /** 面向用户的可理解文案（禁止技术术语） */
    message: z.string(),
    /** 建议的处置方式 */
    suggestions: z.array(z.string()).default([]),
    /** 是否可重试 */
    retryable: z.boolean().default(false),
  }),
  /** 请求追踪 id，用户报障时提供 */
  requestId: z.string().optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** 分页响应体 */
export interface PageBody<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** 删除 / 无内容操作的响应体 */
export interface OkBody {
  ok: true;
}

/* -------------------------------------------------------------------------- */
/* SSE 事件协议（与 REST 分离）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 实时事件类型。
 *
 * 对应技术文档第 72 条要求实时返回的内容：
 * agent message / plan / task status / progress / asset created / video generated / error
 */
export const SSE_EVENT_TYPES = [
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

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/**
 * SSE 事件信封。
 *
 * `seq` 是**每个会话内单调递增**的序号，客户端通过 `Last-Event-ID`
 * 在断线重连时请求补发。服务端实现必须保证：
 * **先订阅、再 replay**（或 replay 后无条件继续订阅），
 * 否则会出现「重连后推送永久静默」的严重缺陷（审计结论 ⑫）。
 */
export interface SseEnvelope<T = unknown> {
  /** 会话内单调递增序号 */
  seq: number;
  /** 事件类型 */
  type: SseEventType;
  /** 产生时间（ISO 8601） */
  at: string;
  /** 归属会话，服务端强制校验，防止跨用户事件泄漏 */
  sessionId: string;
  data: T;
}

/** SSE 事件 data 负载的通用结构 */
export const sseEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.enum(SSE_EVENT_TYPES),
  at: z.string(),
  sessionId: z.string().min(1),
  data: z.unknown(),
});
