/**
 * Workflow 类型（文档 §11）。
 *
 * 纯状态机模型：Workflow = 节点 DAG（依赖拓扑）。
 * input/output 为可 JSON 序列化的纯数据（跨节点传递、落库）。
 */

export type WorkflowStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "retrying"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowNode {
  /** 逻辑节点 id（如 "script"、"storyboard"），工作流内唯一 */
  id: string;
  /** 节点类型（如 "script.generate"、"scene.generate"），由执行器分派 */
  type: string;
  name: string;
  status: WorkflowNodeStatus;
  /** 依赖节点 id 列表 */
  dependsOn: string[];
  /** 节点输入（可选；缺省时由依赖输出合并） */
  input?: unknown;
  /** 执行输出（可 JSON 序列化，执行成功后写入） */
  output?: unknown;
  retryCount: number;
  maxRetries: number;
  /** 最近一次失败原因 */
  error?: string;
}

export interface Workflow {
  id: string;
  projectId: string;
  status: WorkflowStatus;
  nodes: WorkflowNode[];
}
