/**
 * Workflow 服务工作流编排（文档 §11 / §15 / §20）。
 *
 * 职责：
 * - 工作流/节点持久化（drizzle）
 * - 执行生命周期：run（后台执行）→ pause / resume / cancel → 失败重试
 * - 事件订阅（SSE 总线，供 /events 路由转发）
 *
 * 节点能力通过 executorFactory 注入（组合根注入带 Agent Profile 的
 * Agent 执行器），服务本身不依赖 Agent Runtime，仅依赖 NodeExecutor 抽象。
 */
import { EventEmitter } from "node:events";
import { and, asc, eq } from "drizzle-orm";
import { randomId } from "@svh/shared";
import {
  WorkflowEngine,
  topoSort,
  type NodeExecutor,
  type Workflow,
  type WorkflowEvent,
  type WorkflowNode,
  type WorkflowStatus,
} from "@svh/core";
import type { ModelConfig } from "@svh/providers";
import {
  workflowNodes as workflowNodesTable,
  workflows as workflowsTable,
  type SVHDatabase,
  type WorkflowRow,
} from "@svh/database";
import { conflictError, notFoundError, validationError } from "@svh/production";

/** 一次工作流执行的运行上下文（由路由层解析后传入） */
export interface WorkflowRunContext {
  sessionId: string;
  workspaceId: string;
  userId: string;
  modelConfig: ModelConfig;
}

export interface WorkflowServiceDeps {
  db: SVHDatabase;
  /** 节点执行器工厂（组合根注入：Agent + Profile 实现；测试注入假实现） */
  executorFactory: (ctx: WorkflowRunContext) => NodeExecutor;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/** 默认生产 DAG（文档 §12：script → characters/scenes → storyboard） */
export interface DefaultNodeSpec {
  id: string;
  type: string;
  name: string;
  dependsOn: string[];
  input?: unknown;
}

export const DEFAULT_WORKFLOW_NODES: DefaultNodeSpec[] = [
  { id: "script", type: "script.generate", name: "生成剧本", dependsOn: [] },
  { id: "characters", type: "character.extract", name: "提取角色", dependsOn: ["script"] },
  { id: "scenes", type: "scene.generate", name: "生成场景", dependsOn: ["script"] },
  { id: "storyboard", type: "storyboard.generate", name: "生成分镜", dependsOn: ["scenes", "characters"] },
];

/** 可运行的工作流状态（其他状态运行直接拒绝） */
const RUNNABLE_STATUSES: WorkflowStatus[] = ["draft", "queued", "paused", "failed"];

interface RunningState {
  engine: WorkflowEngine;
  emitter: EventEmitter;
}

export class WorkflowService {
  private readonly running = new Map<string, RunningState>();
  private readonly emitters = new Map<string, EventEmitter>();

  constructor(private readonly deps: WorkflowServiceDeps) {}

  // ================= 创建 / 读取 =================

  /** 创建工作流（可传入自定义节点；缺省使用生产 DAG，story 注入第一个节点的 prompt） */
  async createWorkflow(
    projectId: string,
    userId: string,
    options: { nodes?: Array<Pick<WorkflowNode, "id" | "type" | "name" | "dependsOn" | "input">>; story?: string } = {},
  ): Promise<unknown> {
    const specs = options.nodes ?? DEFAULT_WORKFLOW_NODES;
    const nodes: WorkflowNode[] = specs.map((spec) => ({
      id: spec.id,
      type: spec.type,
      name: spec.name,
      status: "pending",
      dependsOn: spec.dependsOn,
      input: spec.input,
      retryCount: 0,
      maxRetries: 1,
    }));
    if (options.story && !options.nodes) {
      nodes[0] = { ...nodes[0]!, input: { prompt: options.story } };
    }
    // 领域校验：id 唯一、依赖存在、无环（缺失/循环 → VALIDATION）
    try {
      topoSort(nodes);
    } catch (err) {
      throw validationError(err instanceof Error ? err.message : "工作流节点定义不合法");
    }

    const workflowId = randomId("wfl");
    this.deps.db
      .insert(workflowsTable)
      .values({
        id: workflowId,
        projectId,
        userId,
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    for (const [index, node] of nodes.entries()) {
      this.deps.db
        .insert(workflowNodesTable)
        .values({
          id: randomId("wno"),
          workflowId,
          nodeId: node.id,
          type: node.type,
          name: node.name,
          status: "pending",
          sortOrder: index,
          dependsOn: node.dependsOn,
          input: node.input,
          retryCount: 0,
          maxRetries: node.maxRetries,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    }
    return this.getWorkflow(workflowId);
  }

  async listWorkflows(projectId: string): Promise<unknown[]> {
    const rows = this.deps.db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.projectId, projectId))
      .orderBy(asc(workflowsTable.updatedAt), asc(workflowsTable.id))
      .all();
    return Promise.all(rows.map((row) => this.assemble(row)));
  }

  async getWorkflow(id: string): Promise<unknown> {
    const row = this.deps.db.select().from(workflowsTable).where(eq(workflowsTable.id, id)).get();
    if (!row) {
      throw notFoundError("工作流");
    }
    return this.assemble(row);
  }

  // ================= 执行控制 =================

  /** 运行工作流（后台执行，立即返回 queued 状态） */
  async runWorkflow(id: string, ctx: WorkflowRunContext): Promise<unknown> {
    const current = (await this.getWorkflow(id)) as {
      id: string;
      projectId: string;
      status: WorkflowStatus;
    };
    if (!RUNNABLE_STATUSES.includes(current.status)) {
      throw conflictError(`工作流当前状态（${current.status}）不可运行`);
    }
    this.setWorkflowStatus(id, "queued");
    this.lastCtx.set(id, ctx);
    const engine = new WorkflowEngine();
    const state: RunningState = { engine, emitter: this.emitter(id) };
    this.running.set(id, state);
    // 后台执行：不阻塞请求
    void this.executeRun(id, ctx, state);
    return this.getWorkflow(id);
  }

  async pauseWorkflow(id: string): Promise<void> {
    const state = this.running.get(id);
    if (!state) {
      throw conflictError("工作流未在运行中，无法暂停");
    }
    state.engine.pause();
    this.setWorkflowStatus(id, "paused");
    state.emitter.emit("event", { type: "workflow.paused", workflowId: id });
  }

  async resumeWorkflow(id: string): Promise<void> {
    const state = this.running.get(id);
    if (!state) {
      throw conflictError("工作流未在运行中，无法恢复");
    }
    state.engine.resume();
    this.setWorkflowStatus(id, "running");
    state.emitter.emit("event", { type: "workflow.resumed", workflowId: id });
  }

  async cancelWorkflow(id: string): Promise<void> {
    const state = this.running.get(id);
    if (!state) {
      throw conflictError("工作流未在运行中，无法取消");
    }
    state.engine.cancel();
  }

  /** 失败重试：重置目标节点与级联取消的下游为 pending，重新执行 */
  async retryNode(workflowId: string, nodeId: string): Promise<unknown> {
    const workflow = (await this.getWorkflow(workflowId)) as {
      id: string;
      projectId: string;
      status: WorkflowStatus;
      nodes: Array<{ id: string; status: string; dependsOn: string[] }>;
    };
    if (workflow.status !== "failed") {
      throw conflictError("仅失败状态的工作流支持重试节点");
    }
    const target = workflow.nodes.find((n) => n.id === nodeId);
    if (!target) {
      throw notFoundError("工作流节点");
    }
    if (target.status !== "failed" && target.status !== "cancelled") {
      throw conflictError("仅失败/被取消的节点可重试");
    }
    // 重置目标节点 + 其下游（级联取消的节点）为 pending
    const downstream = this.downstreamOf(nodeId, workflow.nodes);
    for (const n of workflow.nodes) {
      if (n.id === nodeId || downstream.has(n.id)) {
        this.deps.db
          .update(workflowNodesTable)
          .set({ status: "pending", retryCount: 0, error: null, updatedAt: new Date() })
          .where(
            and(eq(workflowNodesTable.workflowId, workflowId), eq(workflowNodesTable.nodeId, n.id)),
          )
          .run();
      }
    }
    // 重新启动
    await this.runWorkflow(workflowId, this.lastRunContext(workflowId));
    return this.getWorkflow(workflowId);
  }

  // ================= 事件订阅 =================

  /** 订阅工作流事件（返回取消订阅函数） */
  subscribe(id: string, listener: (event: WorkflowEvent) => void): () => void {
    const emitter = this.emitter(id);
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  }

  /** 是否正在运行 */
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  // ================= 内部实现 =================

  private emitter(id: string): EventEmitter {
    let emitter = this.emitters.get(id);
    if (!emitter) {
      emitter = new EventEmitter();
      this.emitters.set(id, emitter);
    }
    return emitter;
  }

  private async executeRun(id: string, ctx: WorkflowRunContext, state: RunningState): Promise<void> {
    const executor = this.deps.executorFactory(ctx);
    const workflow = (await this.getWorkflow(id)) as {
      id: string;
      projectId: string;
      status: WorkflowStatus;
      nodes: WorkflowNode[];
    };
    const engineWorkflow: Workflow = {
      id: workflow.id,
      projectId: workflow.projectId,
      status: "queued",
      nodes: workflow.nodes,
    };
    try {
      for await (const event of state.engine.run(engineWorkflow, executor)) {
        await this.persistEvent(id, event);
        state.emitter.emit("event", event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.error({ workflowId: id, error: message }, "workflow run error");
      const event = { type: "workflow.failed" as const, workflowId: id, error: message };
      await this.persistEvent(id, event);
      state.emitter.emit("event", event);
    } finally {
      this.running.delete(id);
    }
  }

  /** 将引擎事件持久化到 DB（节点状态/输出/错误 + 工作流状态） */
  private async persistEvent(workflowId: string, event: WorkflowEvent): Promise<void> {
    const base = { updatedAt: new Date() };
    switch (event.type) {
      case "node.started":
        this.deps.db
          .update(workflowNodesTable)
          .set({ status: "running", ...base, error: null })
          .where(and(eq(workflowNodesTable.workflowId, workflowId), eq(workflowNodesTable.nodeId, event.nodeId)))
          .run();
        break;
      case "node.completed":
        this.deps.db
          .update(workflowNodesTable)
          .set({ status: "completed", output: event.output, ...base, error: null })
          .where(and(eq(workflowNodesTable.workflowId, workflowId), eq(workflowNodesTable.nodeId, event.nodeId)))
          .run();
        break;
      case "node.retrying":
        this.deps.db
          .update(workflowNodesTable)
          .set({ status: "retrying", retryCount: event.attempt, ...base })
          .where(and(eq(workflowNodesTable.workflowId, workflowId), eq(workflowNodesTable.nodeId, event.nodeId)))
          .run();
        break;
      case "node.failed":
        this.deps.db
          .update(workflowNodesTable)
          .set({ status: "failed", error: event.error, retryCount: event.retryCount, ...base })
          .where(and(eq(workflowNodesTable.workflowId, workflowId), eq(workflowNodesTable.nodeId, event.nodeId)))
          .run();
        break;
      case "node.cancelled":
        this.deps.db
          .update(workflowNodesTable)
          .set({ status: "cancelled", ...base })
          .where(and(eq(workflowNodesTable.workflowId, workflowId), eq(workflowNodesTable.nodeId, event.nodeId)))
          .run();
        break;
      case "workflow.started":
        this.setWorkflowStatus(workflowId, "running");
        break;
      case "workflow.completed":
        this.setWorkflowStatus(workflowId, "completed");
        break;
      case "workflow.failed":
        this.setWorkflowStatus(workflowId, "failed");
        break;
      case "workflow.cancelled":
        this.setWorkflowStatus(workflowId, "cancelled");
        break;
      case "workflow.paused":
        this.setWorkflowStatus(workflowId, "paused");
        break;
      case "workflow.resumed":
        this.setWorkflowStatus(workflowId, "running");
        break;
    }
  }

  /** 组装工作流视图（workflow + nodes 合并） */
  private async assemble(
    row: WorkflowRow,
  ): Promise<{
    id: string;
    projectId: string;
    userId: string;
    status: WorkflowStatus;
    createdAt: Date;
    updatedAt: Date;
    nodes: WorkflowNode[];
  }> {
    const nodeRows = this.deps.db
      .select()
      .from(workflowNodesTable)
      .where(eq(workflowNodesTable.workflowId, row.id))
      .orderBy(asc(workflowNodesTable.sortOrder), asc(workflowNodesTable.id))
      .all();
    const nodes: WorkflowNode[] = nodeRows.map((n) => ({
      id: n.nodeId,
      type: n.type,
      name: n.name,
      status: n.status as WorkflowNode["status"],
      dependsOn: n.dependsOn,
      input: n.input ?? undefined,
      output: n.output ?? undefined,
      retryCount: n.retryCount,
      maxRetries: n.maxRetries,
      error: n.error ?? undefined,
    }));
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      status: row.status as WorkflowStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      nodes,
    };
  }

  private setWorkflowStatus(id: string, status: WorkflowStatus): void {
    this.deps.db
      .update(workflowsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(workflowsTable.id, id))
      .run();
  }

  private downstreamOf(nodeId: string, nodes: Array<{ id: string; dependsOn: string[] }>): Set<string> {
    const result = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (result.has(node.id) || node.id === nodeId) continue;
        if (node.dependsOn.some((dep) => dep === nodeId || result.has(dep))) {
          result.add(node.id);
          changed = true;
        }
      }
    }
    return result;
  }

  /** 重试时复用最近一次运行上下文（内存保留最近 ctx） */
  private lastCtx = new Map<string, WorkflowRunContext>();

  private lastRunContext(workflowId: string): WorkflowRunContext {
    const ctx = this.lastCtx.get(workflowId);
    if (!ctx) {
      // 无法从历史恢复上下文时（如服务重启后），由路由层确保重试携带新 ctx；
      // 这里给出明确错误提示，调用方应通过 runWorkflow 传 ctx。
      throw conflictError("重试需要重新提供运行上下文，请重新触发运行");
    }
    return ctx;
  }
}
