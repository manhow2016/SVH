/**
 * Workflow 构造辅助函数
 *
 * 目的：让四套内置流程的定义读起来接近技术文档里的流程图，
 * 同时保证生成的 DAG 结构（尤其是 dependsOn 与 edges）完全一致。
 *
 * 关键约定：
 * - 节点 key 使用小写 snake_case，稳定不变（任务通过 workflowNodeKey 回指）
 * - `edges` 由 `dependsOn` 自动派生，避免手写两份导致不一致
 */
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@svh/domain';

/** 节点定义输入：省略 dependsOn/input 的默认值 */
export interface NodeSpec {
  key: string;
  title: string;
  /** 要执行的 Skill；纯结构化节点（如「产品分析」）可省略 */
  skill?: string;
  /** 依赖的上游节点 */
  dependsOn?: string[];
  /** 输入模板，支持 {{节点key.字段}} 占位符 */
  input?: Record<string, unknown>;
  /** 是否高成本节点（执行前需用户确认） */
  highCost?: boolean;
  /** 失败后是否继续推进下游 */
  continueOnError?: boolean;
  /** 预估耗时（秒） */
  estimatedSeconds?: number;
}

/** 将 NodeSpec 规范化为 WorkflowNode */
function toNode(spec: NodeSpec): WorkflowNode {
  return {
    key: spec.key,
    title: spec.title,
    ...(spec.skill !== undefined ? { skill: spec.skill } : {}),
    dependsOn: spec.dependsOn ?? [],
    input: spec.input ?? {},
    highCost: spec.highCost ?? false,
    continueOnError: spec.continueOnError ?? false,
    ...(spec.estimatedSeconds !== undefined ? { estimatedSeconds: spec.estimatedSeconds } : {}),
  };
}

/** 由 dependsOn 派生边列表 */
function deriveEdges(nodes: WorkflowNode[]): WorkflowDefinition['edges'] {
  const edges: WorkflowDefinition['edges'] = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      edges.push({ from: dep, to: node.key, condition: 'success' });
    }
  }
  return edges;
}

/**
 * 构建并校验一个 Workflow 定义。
 *
 * 使用 `workflowDefinitionSchema.parse` 做校验，因此内置流程在
 * **模块加载时**就会暴露环、重复 key、悬空依赖等问题，
 * 而不是等到运行时才失败。
 */
export function defineWorkflow(input: {
  type: string;
  name: string;
  description: string;
  version?: string;
  nodes: NodeSpec[];
  metadata?: Record<string, unknown>;
}): WorkflowDefinition {
  const nodes = input.nodes.map(toNode);
  return workflowDefinitionSchema.parse({
    type: input.type,
    name: input.name,
    description: input.description,
    version: input.version ?? '1.0.0',
    origin: 'builtin',
    nodes,
    edges: deriveEdges(nodes),
    metadata: input.metadata ?? {},
  });
}
