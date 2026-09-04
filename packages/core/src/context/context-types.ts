import type { ChatMessage } from "@svh/providers";

/**
 * Context Builder 输出（文档 §24）。
 *
 * V1 Context：
 *   System Prompt
 *   + VIDEO_AGENTS.md
 *   + Workspace Summary
 *   + Session Message History（最近 50 条）
 *   + Current User Message
 */
export interface BuiltContext {
  /** 发送给模型的完整消息列表（system + history + user） */
  messages: ChatMessage[];
  /** 实际使用的 system 内容 */
  systemPrompt: string;
  /** 是否叠加了 VIDEO_AGENTS.md 指令 */
  hasWorkspaceInstructions: boolean;
}
