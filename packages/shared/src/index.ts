/**
 * SVH 共享基础类型与工具
 *
 * 该包只包含无副作用的基础定义，被 database / workspace / providers /
 * tools / core / server 共同依赖，禁止反向依赖任何上层包。
 */

/** 统一错误结构（详见 SVH 文档第 47 节） */
export interface AppError {
  code: string;
  message: string;
  details?: unknown;
}

/** 服务端 API 错误响应体 */
export interface ErrorResponse {
  error: AppError;
}

/** Session 状态（文档 §21） */
export type SessionStatus = "idle" | "running" | "error";

/** Session 数据模型（文档 §21） */
export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  status: SessionStatus;
  modelProviderId: string;
  modelId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 消息角色（文档 §22） */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 技能消息元数据（技能执行的用户消息与结果消息标记） */
export interface SkillMessageMeta {
  skillId: string;
  skillName: string;
  params: Record<string, string | number>;
  modelName: string;
  resultKind: "text" | "image" | "video" | "audio";
}

/** 消息元数据（Tool Input/Output/ToolCallID 等，数据库 JSON 字段） */
export interface MessageMetadata {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: boolean;
  /** assistant 消息携带的工具调用列表 */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** 技能执行标记（用户消息与结果消息均携带） */
  skill?: SkillMessageMeta;
}

/** Session Message（文档 §22） */
export interface SessionMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  metadata?: MessageMetadata;
  createdAt: Date;
}

/** 生成简单随机 ID（不依赖第三方库） */
export function randomId(prefix: string): string {
  const ts = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) {
    rand += b.toString(36).padStart(2, "0");
  }
  return `${prefix}_${ts}${rand}`;
}

/** 时间戳（毫秒）转 ISO 字符串 */
export function toISO(d: Date | number): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}
