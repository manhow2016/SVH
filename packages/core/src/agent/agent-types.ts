import type { ModelConfig } from "@svh/providers";
import type { AgentEvent } from "../events/agent-events";
import type { AgentProfile } from "./agent-profile";

/**
 * AgentRunInput（文档 §7.2）。
 *
 * 禁止将 Fastify Request / HTTP Response / React State 传入 Core，
 * Core 只能接收纯数据对象。
 */
export interface AgentRunInput {
  sessionId: string;
  workspaceId: string;
  userMessage: string;
  modelConfig: ModelConfig;
  /** 可选：Agent Profile（角色提示词 + 工具白名单；缺省 = 默认通用 Agent） */
  profile?: AgentProfile;
}

/** Agent Runtime 接口（文档 §7.1） */
export interface AgentRuntimeLike {
  run(input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
