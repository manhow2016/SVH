/**
 * Workflow（工作流）领域模型
 *
 * 对应技术文档第 23~28、45 条。
 *
 * 关键约束：**Workflow 必须独立于 Agent，且不得写死在 Agent 内部**。
 * Workflow 是一份可序列化的 DAG 描述，Agent 的职责只是「规划出这份描述」，
 * 执行推进由 Workflow Engine 完成 —— API 与 Worker 共用同一套推进逻辑。
 *
 * 因此本文件同时提供纯函数形式的图算法（拓扑分层 / 就绪判断 / 环检测），
 * 不依赖数据库，便于单测。
 */
import { z } from 'zod';
import { WORKFLOW_ORIGINS, WORKFLOW_RUN_STATUSES } from './enums.js';
import { idSchema } from './common.js';

export const workflowOriginSchema = z.enum(WORKFLOW_ORIGINS);
export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);

/** 节点状态 */
export const nodeStateSchema = z.enum([
  'pending',
  'ready',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type NodeState = z.infer<typeof nodeStateSchema>;

/**
 * Workflow 节点。
 *
 * `key` 在单个 Workflow 内唯一且稳定，用于 `workflowNodeKey` 回指任务。
 */
export const workflowNodeSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*$/, '节点 key 只允许小写字母、数字和下划线'),
  /** 展示名，如「生成分镜」 */
  title: z.string().min(1).max(200),
  /** 要执行的 Skill；为 workflow 时表示嵌套子工作流 */
  skill: z.string().max(128).optional(),
  /** 该节点的输入模板，支持 {{节点key.字段}} 占位符引用上游产出 */
  input: z.record(z.string(), z.unknown()).default({}),
  /** 依赖的上游节点 key */
  dependsOn: z.array(z.string().max(128)).max(200).default([]),
  /** 是否为高成本节点（执行前需确认） */
  highCost: z.boolean().default(false),
  /** 失败后是否允许继续推进下游 */
  continueOnError: z.boolean().default(false),
  /** 覆盖 Skill 默认重试次数 */
  maxAttempts: z.number().int().min(1).max(10).optional(),
  /** 该节点预计耗时（秒） */
  estimatedSeconds: z.number().positive().max(7200).optional(),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

/** 节点间的边：显式表达依赖关系，便于前端绘制 DAG */
export const workflowEdgeSchema = z.object({
  from: z.string().min(1).max(128),
  to: z.string().min(1).max(128),
  /**
   * 条件表达式，如 `success` / `failed`。
   * 留空表示无条件（上游成功后执行）。
   */
  condition: z.enum(['success', 'failed', 'always']).default('success'),
});

export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

/**
 * Workflow 定义的**形状**（不含 DAG 校验）。
 *
 * 为什么拆成两个 Schema：`ZodEffects`（`.superRefine()` 的返回值）不支持
 * `.omit()` / `.partial()` 等对象方法。拆开之后，外部就可以基于纯对象
 * Schema 做 `.omit({ id: true })` 之类的组合，例如创建工作流时不需要 id。
 */
export const workflowDefinitionShapeSchema = z.object({
  id: idSchema.optional(),
  /** 目标内容类型 */
  type: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default('1.0.0'),
  origin: workflowOriginSchema.default('builtin'),
  /** 节点列表 */
  nodes: z.array(workflowNodeSchema).min(1).max(500),
  /** 边列表（可由 nodes.dependsOn 推导，此处持久化便于前端直接渲染） */
  edges: z.array(workflowEdgeSchema).max(1000).default([]),
  /** 全局元数据（默认画幅、默认平台等） */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Workflow 定义的 DAG 校验规则。
 *
 * 单独导出，便于在「只做校验」的场景（如创建工作流接口）复用，
 * 而不需要重新构造 Schema。
 */
export function validateWorkflowGraph(
  wf: Pick<WorkflowDefinitionShape, 'nodes'>,
  ctx: z.RefinementCtx,
): void {
  const keys = new Set<string>();
  for (const node of wf.nodes) {
    if (keys.has(node.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `节点 key 重复：${node.key}`,
        path: ['nodes'],
      });
    }
    keys.add(node.key);
  }
  for (const node of wf.nodes) {
    for (const dep of node.dependsOn) {
      if (!keys.has(dep)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `节点 ${node.key} 依赖了不存在的节点 ${dep}`,
          path: ['nodes'],
        });
      }
      if (dep === node.key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `节点 ${node.key} 不能依赖自身`,
          path: ['nodes'],
        });
      }
    }
  }
  // 环检测：Workflow 必须是 DAG
  const cycle = detectCycle(wf.nodes);
  if (cycle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Workflow 存在环：${cycle.join(' → ')}`,
      path: ['nodes'],
    });
  }
}

/** Workflow 定义的形状类型 */
export type WorkflowDefinitionShape = z.infer<typeof workflowDefinitionShapeSchema>;

/**
 * Workflow 定义（文档第 28 条）。
 *
 * V0.1 支持四套内置 Workflow（广告 / 短视频 / 短剧 / 数字人），
 * 但**定义本身是数据**，因此 Agent 可以动态规划出新的 Workflow 并持久化。
 */
export const workflowDefinitionSchema = workflowDefinitionShapeSchema.superRefine(
  validateWorkflowGraph,
);

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/* -------------------------------------------------------------------------- */
/* 图算法（纯函数，无副作用）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 检测依赖环。
 * @returns 若存在环，返回环上的节点 key 序列；否则返回 null。
 */
export function detectCycle(nodes: readonly WorkflowNode[]): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const stack: string[] = [];

  for (const node of nodes) color.set(node.key, WHITE);

  const visit = (key: string): string[] | null => {
    color.set(key, GRAY);
    stack.push(key);
    const node = byKey.get(key);
    for (const dep of node?.dependsOn ?? []) {
      if (!byKey.has(dep)) continue;
      const c = color.get(dep);
      if (c === GRAY) {
        // 找到环：截取栈中从 dep 开始的部分
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(key, BLACK);
    return null;
  };

  for (const node of nodes) {
    if (color.get(node.key) === WHITE) {
      const found = visit(node.key);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 按依赖关系做拓扑分层。
 *
 * 同一层内的节点互不依赖，**可以并行执行**（文档第 45 条：
 * 角色与场景可并行，剧本 → 分镜 → 视频必须串行）。
 *
 * @returns 分层后的节点 key 数组；若存在环则抛出错误。
 */
export function topologicalLayers(nodes: readonly WorkflowNode[]): string[][] {
  const cycle = detectCycle(nodes);
  if (cycle) {
    throw new Error(`Workflow 存在循环依赖：${cycle.join(' → ')}`);
  }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = node.dependsOn.filter((d) => byKey.has(d));
    indegree.set(node.key, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.key);
      dependents.set(dep, list);
    }
  }

  const layers: string[][] = [];
  let frontier = nodes.filter((n) => (indegree.get(n.key) ?? 0) === 0).map((n) => n.key);

  while (frontier.length > 0) {
    layers.push([...frontier].sort());
    const next: string[] = [];
    for (const key of frontier) {
      for (const dependent of dependents.get(key) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    frontier = next;
  }

  const scheduled = layers.flat().length;
  if (scheduled !== nodes.length) {
    throw new Error(`Workflow 拓扑排序不完整：已调度 ${scheduled} / 共 ${nodes.length}`);
  }
  return layers;
}

/** 节点运行态 */
export const workflowNodeStateSchema = z.object({
  key: z.string().min(1).max(128),
  state: nodeStateSchema.default('pending'),
  /** 该节点的任务 id */
  taskId: idSchema.nullable().optional(),
  /** 节点产出，供下游占位符引用 */
  output: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().max(5000).nullable().optional(),
  attempts: z.number().int().nonnegative().default(0),
  startedAt: z.string().datetime().nullable().optional(),
  finishedAt: z.string().datetime().nullable().optional(),
});

export type WorkflowNodeState = z.infer<typeof workflowNodeStateSchema>;

/** Workflow Run 的完整状态：持久化在 workflow_runs.state 中 */
export const workflowRunStateSchema = z.object({
  nodes: z.record(z.string(), workflowNodeStateSchema).default({}),
  /** 当前执行到第几层（便于前端展示整体进度） */
  currentLayer: z.number().int().nonnegative().default(0),
  /** 总层数 */
  totalLayers: z.number().int().nonnegative().default(0),
});

export type WorkflowRunState = z.infer<typeof workflowRunStateSchema>;

/** 初始化运行状态 */
export function initRunState(definition: WorkflowDefinition): WorkflowRunState {
  const layers = topologicalLayers(definition.nodes);
  const nodes: Record<string, WorkflowNodeState> = {};
  for (const node of definition.nodes) {
    nodes[node.key] = workflowNodeStateSchema.parse({ key: node.key });
  }
  return { nodes, currentLayer: 0, totalLayers: layers.length };
}

/**
 * 计算当前可执行（就绪）的节点。
 *
 * 判定规则：
 * - 自身状态为 pending
 * - 所有上游节点已完成（succeeded，或 failed 且自身 continueOnError）
 * - 若任一上游 failed 且未标记 continueOnError，则该节点进入 skipped
 *
 * @returns `ready` 为可执行节点 key；`skipped` 为应标记跳过的节点 key。
 */
export function computeReadyNodes(
  definition: WorkflowDefinition,
  state: WorkflowRunState,
): { ready: string[]; skipped: string[] } {
  const ready: string[] = [];
  const skipped: string[] = [];

  for (const node of definition.nodes) {
    const self = state.nodes[node.key];
    if (!self || self.state !== 'pending') continue;

    let blocked = false;
    let satisfiable = true;
    for (const dep of node.dependsOn) {
      const upstream = state.nodes[dep];
      if (!upstream) continue;
      if (upstream.state === 'succeeded') continue;
      if (
        (upstream.state === 'failed' || upstream.state === 'cancelled' || upstream.state === 'skipped') &&
        node.continueOnError
      ) {
        continue;
      }
      if (upstream.state === 'failed' || upstream.state === 'cancelled' || upstream.state === 'skipped') {
        satisfiable = false;
        break;
      }
      // 上游尚未完成
      blocked = true;
    }

    if (!satisfiable) {
      skipped.push(node.key);
    } else if (!blocked) {
      ready.push(node.key);
    }
  }

  return { ready: ready.sort(), skipped: skipped.sort() };
}

/** 判断整个运行是否已结束 */
export function isRunFinished(
  definition: WorkflowDefinition,
  state: WorkflowRunState,
): { finished: boolean; success: boolean } {
  let success = true;
  for (const node of definition.nodes) {
    const self = state.nodes[node.key];
    const s = self?.state ?? 'pending';
    if (s === 'pending' || s === 'ready' || s === 'running') {
      return { finished: false, success: false };
    }
    if (s === 'failed' && !node.continueOnError) success = false;
  }
  return { finished: true, success };
}
