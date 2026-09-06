/**
 * Workflow 事件（文档 §11：状态机对外输出的可观测事件流）。
 */
import type { WorkflowNodeStatus, WorkflowStatus } from "./workflow-types";

export type WorkflowEvent =
  | { type: "workflow.started"; workflowId: string }
  | { type: "workflow.completed"; workflowId: string }
  | { type: "workflow.failed"; workflowId: string; error: string }
  | { type: "workflow.cancelled"; workflowId: string }
  | { type: "workflow.paused"; workflowId: string }
  | { type: "workflow.resumed"; workflowId: string }
  | { type: "node.started"; workflowId: string; nodeId: string }
  | { type: "node.completed"; workflowId: string; nodeId: string; output?: unknown }
  | { type: "node.failed"; workflowId: string; nodeId: string; error: string; retryCount: number }
  | { type: "node.retrying"; workflowId: string; nodeId: string; attempt: number }
  | { type: "node.cancelled"; workflowId: string; nodeId: string };

/** 终态事件（SSE 订阅方可据此关闭连接） */
export function isTerminalWorkflowEvent(event: WorkflowEvent): boolean {
  return (
    event.type === "workflow.completed" ||
    event.type === "workflow.failed" ||
    event.type === "workflow.cancelled"
  );
}

/** 事件中包含的节点状态（供持久化回调使用） */
export function nodeStatusFromEvent(event: WorkflowEvent): WorkflowNodeStatus | null {
  switch (event.type) {
    case "node.started":
      return "running";
    case "node.completed":
      return "completed";
    case "node.retrying":
      return "retrying";
    case "node.failed":
      return "failed";
    case "node.cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** 事件中包含的工作流状态（供持久化回调使用） */
export function workflowStatusFromEvent(event: WorkflowEvent): WorkflowStatus | null {
  switch (event.type) {
    case "workflow.started":
      return "running";
    case "workflow.completed":
      return "completed";
    case "workflow.failed":
      return "failed";
    case "workflow.cancelled":
      return "cancelled";
    case "workflow.paused":
      return "paused";
    case "workflow.resumed":
      return "running";
    default:
      return null;
  }
}
