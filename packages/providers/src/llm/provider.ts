/**
 * LLM Provider 抽象（文档 §11）。
 *
 * Provider 层禁止依赖 Workspace / Database / Server，
 * 只负责：Request → LLM API → Streaming Response。
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 发给 LLM 的规范化消息（Provider 内部结构） */
export interface ChatMessage {
  role: ChatRole;
  /** assistant 消息可能为 null（纯 tool_call 响应） */
  content: string | null;
  /** tool 角色消息关联的 toolCallId */
  toolCallId?: string;
  /** assistant 消息携带的 tool_calls */
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/** 提供给模型的工具定义（OpenAI function calling 格式） */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object; // JSON Schema
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

/** LLM Streaming 事件 */
export type LLMEvent =
  /** 文本增量 */
  | { type: "delta"; content: string }
  /** 完整工具调用（流结束后一次性发出） */
  | { type: "tool_call"; toolCall: { id: string; name: string; arguments: string } }
  /** 流正常结束 */
  | { type: "done" }
  /** 发生错误（不抛异常，通过事件传递） */
  | { type: "error"; error: string };

/** LLM Provider 接口 */
export interface LLMProvider {
  id: string;
  /** 发起流式对话，signal 用于终止（Stop） */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}

/** 模型配置（来自环境变量或 Settings） */
export interface ModelConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}
