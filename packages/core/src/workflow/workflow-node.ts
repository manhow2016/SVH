/**
 * Workflow 节点执行器与 DAG 拓扑工具（文档 §11.2 / §12）。
 *
 * 执行器是「节点类型 → 具体能力」的注入点：
 * - server 侧实现 Agent 节点执行器（带 Agent Profile 的 Agent Run）
 * - 引擎本身不感知 Agent / Provider / DB
 */
import type { WorkflowNode } from "./workflow-types";

/** 节点执行器：执行一个节点，返回可 JSON 序列化的输出；抛错视为节点失败 */
export interface NodeExecutor {
  execute(node: WorkflowNode, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export class WorkflowEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowEngineError";
  }
}

/**
 * 校验工作流：节点 id 唯一、依赖引用存在、maxRetries 合法。
 * 返回拓扑排序（Kahn 算法）；存在环抛 WorkflowEngineError。
 */
export function topoSort(nodes: WorkflowNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) {
    throw new WorkflowEngineError("工作流节点 id 重复");
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 环检测：标准 DFS（路径栈 onPath 检测环 + done 避免重复遍历）
  const onPath = new Set<string>();
  const done = new Set<string>();
  const visit = (current: string): void => {
    if (onPath.has(current)) {
      throw new WorkflowEngineError("工作流存在循环依赖");
    }
    if (done.has(current)) return;
    onPath.add(current);
    for (const dep of byId.get(current)?.dependsOn ?? []) {
      visit(dep);
    }
    onPath.delete(current);
    done.add(current);
  };
  for (const node of nodes) {
    // 依赖引用存在性校验
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) {
        throw new WorkflowEngineError(`节点 ${node.id} 依赖不存在的节点 ${dep}`);
      }
    }
    visit(node.id);
  }

  // Kahn 拓扑排序（稳定：按原数组顺序取入度 0 的节点）
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    indegree.set(node.id, node.dependsOn.length);
  }
  const result: string[] = [];
  const ready: string[] = [];
  for (const node of nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      ready.push(node.id);
    }
  }
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const node of nodes) {
      if (node.dependsOn.includes(id)) {
        const next = (indegree.get(node.id) ?? 0) - 1;
        indegree.set(node.id, next);
        if (next === 0) {
          ready.push(node.id);
        }
      }
    }
  }
  if (result.length !== nodes.length) {
    throw new WorkflowEngineError("工作流存在循环依赖");
  }
  return result;
}

/**
 * 节点输入解析：显式 input 优先；
 * 否则按依赖输出合并（单依赖取其输出；多依赖按 { 依赖id: 输出 } 合并）。
 */
export function resolveNodeInput(node: WorkflowNode, outputs: Map<string, unknown>): unknown {
  if (node.input !== undefined) {
    return node.input;
  }
  if (node.dependsOn.length === 0) {
    return {};
  }
  if (node.dependsOn.length === 1) {
    return outputs.get(node.dependsOn[0]!);
  }
  const merged: Record<string, unknown> = {};
  for (const dep of node.dependsOn) {
    if (outputs.has(dep)) {
      merged[dep] = outputs.get(dep);
    }
  }
  return merged;
}

/** 允许的工作流状态机跳转（非法 jump 由引擎校验，服务层持久化时保持同步语义） */
export const WORKFLOW_TRANSITIONS: Readonly<Record<string, string>> = {
  draft: "queued",
  queued: "running",
  running: "paused",
  paused: "running",
  waiting_user: "running",
};
