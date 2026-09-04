/**
 * Agent Runtime 统一事件（文档 §8）。
 *
 * Core 不依赖任何 Web / Server 框架，事件通过 AsyncIterable 输出。
 */
export type AgentEvent =
  | { type: "run.started" }
  | { type: "message.started"; messageId: string }
  | { type: "message.delta"; messageId: string; content: string }
  | { type: "message.completed"; messageId: string }
  | { type: "tool.called"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool.completed"; toolCallId: string; toolName: string; output: unknown }
  | { type: "workspace.changed"; paths: string[] }
  | { type: "run.completed" }
  | { type: "run.error"; error: string };

/** 仅允许事件里的这类错误：用于 Agent 内部判断终态 */
export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "run.completed" || event.type === "run.error";
}
