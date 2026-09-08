/**
 * Workflow 执行循环（文档 §11：依赖调度 + 重试 + 失败级联）。
 *
 * 纯函数式异步生成器：不依赖 DB/HTTP，仅通过 EngineControl 与引擎控制器协作
 * （暂停/取消），通过事件流输出状态变化。
 */
import type { WorkflowEvent } from "./workflow-events";
import { resolveNodeInput, type NodeExecutor } from "./workflow-node";
import type { Workflow, WorkflowNode, WorkflowNodeStatus } from "./workflow-types";
import { topoSort } from "./workflow-node";

/** 引擎控制器（由 WorkflowEngine 提供） */
export interface EngineControl {
  /** 取消信号（跨节点传递；节点执行器应尊重 AbortSignal） */
  signal: AbortSignal;
  isCancelled(): boolean;
  /** 暂停等待：暂停期间阻塞，恢复后 resolve；已取消则立即 resolve */
  waitWhilePaused(): Promise<void>;
  /** 等待用户输入（如人工审核）：挂起期间阻塞，恢复后 resolve；已取消则立即 resolve */
  waitWhileUser(): Promise<void>;
}

/** 执行器输出哨兵键：值为 true 表示「等待用户输入」，引擎挂起循环等待恢复 */
export const WAIT_FOR_USER_KEY = "__waitForUser";

/** 判断执行器输出是否为「等待用户输入」哨兵 */
export function isWaitForUser(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    (output as Record<string, unknown>)[WAIT_FOR_USER_KEY] === true
  );
}

/** 引擎选项：状态持久化回调（server 层借此落库） */
export interface WorkflowLoopOptions {
  onNodeStatus?: (nodeId: string, status: WorkflowNodeStatus) => void;
  onWorkflowStatus?: (workflowId: string, status: Workflow["status"]) => void;
}

/** 标记一个节点为 cancelled 并输出事件（幂等） */
function markCancelled(workflowId: string, node: WorkflowNode, events: WorkflowEvent[]): void {
  if (node.status === "cancelled") return;
  node.status = "cancelled";
  events.push({ type: "node.cancelled", workflowId, nodeId: node.id });
}

/**
 * 取消全部未完成节点并收集待推送事件（幂等）。
 * 调用方负责 `yield*` 产出，随后终结（cancelled 状态 + 事件）。
 */
function cancelTail(order: string[], byId: Map<string, WorkflowNode>, workflowId: string, events: WorkflowEvent[]): WorkflowEvent[] {
  for (const id of order) {
    const n = byId.get(id)!;
    if (n.status !== "completed" && n.status !== "cancelled") {
      markCancelled(workflowId, n, events);
    }
  }
  const out = events.splice(0, events.length);
  return out;
}

export async function* runWorkflowLoop(
  workflow: Workflow,
  executor: NodeExecutor,
  control: EngineControl,
  opts: WorkflowLoopOptions = {},
): AsyncIterable<WorkflowEvent> {
  const { id: workflowId } = workflow;
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const events: WorkflowEvent[] = [];

  const setWorkflow = (status: Workflow["status"]): void => {
    workflow.status = status;
    opts.onWorkflowStatus?.(workflowId, status);
  };

  const setNode = (node: WorkflowNode, status: WorkflowNodeStatus): void => {
    node.status = status;
    opts.onNodeStatus?.(node.id, status);
  };

  // ---- 启动 ----
  setWorkflow("running");
  events.push({ type: "workflow.started", workflowId });
  yield events.pop()!;

  const order = topoSort(workflow.nodes);
  const outputs = new Map<string, unknown>();

  for (const nodeId of order) {
    const node = byId.get(nodeId)!;

    // 重跑模式：已完成的节点直接复用其输出
    if (node.status === "completed") {
      if (node.output !== undefined) {
        outputs.set(node.id, node.output);
      }
      continue;
    }

    // 暂停点（节点边界）：暂停直到恢复或取消
    await control.waitWhilePaused();

    if (control.isCancelled()) {
      // 取消：取消所有未完成节点（重新入队的 pending/cancelled 状态节点）
      yield* cancelTail(order, byId, workflowId, events);
      setWorkflow("cancelled");
      yield { type: "workflow.cancelled", workflowId };
      return;
    }

    // ---- 执行节点（含重试；等待用户恢复后重入同一节点） ----
    const input = resolveNodeInput(node, outputs);

    for (;;) {
      setNode(node, "running");
      yield { type: "node.started", workflowId, nodeId: node.id };

      let succeeded = false;
      let lastError: string | null = null;
      let waitResumed = false;

      for (let attempt = 0; attempt <= node.maxRetries; attempt++) {
        try {
          const output = await executor.execute(node, input, control.signal);
          if (isWaitForUser(output)) {
            // 等待用户输入（如人工审核）：节点置 waiting、发 workflow.waiting、
            // 挂起循环；恢复后重入本节点（外部审核状态幂等，重新检查即可）。
            setNode(node, "waiting");
            yield { type: "workflow.waiting", workflowId, nodeId: node.id };
            await control.waitWhileUser();
            if (control.isCancelled()) {
              yield* cancelTail(order, byId, workflowId, events);
              setWorkflow("cancelled");
              yield { type: "workflow.cancelled", workflowId };
              return;
            }
            waitResumed = true;
            node.retryCount = 0;
            break;
          }
          node.output = output;
          succeeded = true;
          break;
        } catch (err) {
          // 执行期间被取消：识别为「取消」而非节点失败（abort 抛出的错误）
          if (control.isCancelled()) {
            yield* cancelTail(order, byId, workflowId, events);
            setWorkflow("cancelled");
            yield { type: "workflow.cancelled", workflowId };
            return;
          }
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt < node.maxRetries) {
            node.retryCount = attempt + 1;
            setNode(node, "retrying");
            yield { type: "node.retrying", workflowId, nodeId: node.id, attempt: attempt + 1 };
            // 重试前短暂让出事件循环（避免连发阻塞）
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }

      if (waitResumed) {
        // 用户已恢复：重入同一节点重新执行（重新检查外部状态）
        continue;
      }

      if (succeeded) {
        setNode(node, "completed");
        yield { type: "node.completed", workflowId, nodeId: node.id, output: node.output };
        outputs.set(node.id, node.output);
        break;
      }

      // ---- 节点失败：级联取消下游，工作流失败 ----
      node.error = lastError ?? "unknown error";
      setNode(node, "failed");
      yield { type: "node.failed", workflowId, nodeId: node.id, error: node.error, retryCount: node.retryCount };

      // 下游依赖者级联取消（含间接依赖）
      const downstream = new Set<string>();
      for (const id of order) {
        const n = byId.get(id)!;
        if (n.id === node.id || n.status === "completed") continue;
        if (n.dependsOn.some((dep) => dep === node.id || downstream.has(dep))) {
          descendantOf(order, byId, node.id).forEach((did) => downstream.add(did));
          if (n.dependsOn.some((dep) => downstream.has(dep)) || n.dependsOn.includes(node.id)) {
            downstream.add(n.id);
          }
        }
      }
      for (const id of order) {
        const n = byId.get(id)!;
        if (downstream.has(n.id) && n.status !== "completed") {
          markCancelled(workflowId, n, events);
        }
      }
      yield* events;
      events.length = 0;

      setWorkflow("failed");
      yield { type: "workflow.failed", workflowId, error: node.error };
      return;
    }
  }

  // ---- 全部完成 ----
  if (control.isCancelled()) {
    setWorkflow("cancelled");
    yield { type: "workflow.cancelled", workflowId };
    return;
  }
  setWorkflow("completed");
  yield { type: "workflow.completed", workflowId };
}

/** 计算某节点的所有子孙（间接依赖者） */
function descendantOf(order: string[], byId: Map<string, WorkflowNode>, rootId: string): string[] {
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      const n = byId.get(id)!;
      if (result.has(id) || id === rootId) continue;
      if (n.dependsOn.some((dep) => dep === rootId || result.has(dep))) {
        result.add(id);
        changed = true;
      }
    }
  }
  return [...result];
}
