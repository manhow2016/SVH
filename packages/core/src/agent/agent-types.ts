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
  /**
   * 可选：生产上下文文本块（V0.3 Phase 1）。
   *
   * 由 server 层经 `ProductionContextResolver` 组装并渲染后传入，Core 只把它
   * 作为一段纯文本追加到 System Prompt。Core 不感知 Production 领域、不依赖
   * `@svh/production`，保持依赖方向不变（实施文档 §5：扩展现有 ContextBuilder）。
   */
  productionContext?: string;
}

/** Agent Runtime 接口（文档 §7.1） */
export interface AgentRuntimeLike {
  run(input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
