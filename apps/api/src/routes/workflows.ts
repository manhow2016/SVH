/**
 * 工作流路由
 *
 * 对应技术文档第 77 条的 `/api/workflows/*`。
 *
 * 数据来源有两处：
 * - **代码内置模板**（@svh/workflow）：四套标准流程，只读
 * - **数据库记录**：seed 后的副本，以及 Agent 动态规划产生的流程
 *
 * 响应中额外返回 `layers`（拓扑分层），让前端可以直接把「哪些步骤可以
 * 并行」画出来，而不需要自己实现图算法。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  NotFoundError,
  topologicalLayers,
  workflowDefinitionSchema,
  workflowDefinitionShapeSchema,
  WorkflowInvalidError,
  type WorkflowDefinition,
} from '@svh/domain';
import { BUILTIN_WORKFLOWS, listBuiltinWorkflows } from '@svh/workflow';
import { prisma } from '@svh/database';

import { parseBody, parseIdParam, parseQuery } from '../core/validate.js';

/** 工作流列表筛选 */
const listWorkflowsQuerySchema = z.object({
  projectId: z.string().min(1).max(64).optional(),
  type: z.string().max(64).optional(),
  /** 是否包含代码内置模板（默认包含） */
  includeBuiltin: z.coerce.boolean().default(true),
});

/** 把数据库行还原为 Workflow 定义 */
function rowToDefinition(row: {
  id: string;
  type: string;
  name: string;
  description: string;
  version: string;
  origin: string;
  nodes: unknown;
  edges: unknown;
  metadata: unknown;
}): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    version: row.version,
    origin: row.origin,
    nodes: row.nodes,
    edges: row.edges,
    metadata: row.metadata,
  });
}

/**
 * 给定义附加拓扑分层信息。
 * 分层计算失败（如存在环）时不抛出，而是标注 invalid，
 * 避免一个坏流程让整个列表接口 500。
 */
function withLayers(definition: WorkflowDefinition) {
  try {
    return { ...definition, layers: topologicalLayers(definition.nodes), valid: true as const };
  } catch (err) {
    return {
      ...definition,
      layers: [] as string[][],
      valid: false as const,
      invalidReason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  /** 工作流列表：内置模板 + 数据库记录 */
  app.get('/', async (request) => {
    const query = parseQuery(request, listWorkflowsQuerySchema);

    const dbRows = await prisma.workflow.findMany({
      where: {
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });

    const dbDefinitions = dbRows.flatMap((row) => {
      try {
        return [withLayers(rowToDefinition(row))];
      } catch {
        // 数据库中损坏的定义不应该让列表接口失败，跳过并继续
        return [];
      }
    });

    const builtin = query.includeBuiltin
      ? listBuiltinWorkflows()
          .filter((wf) => (query.type ? wf.type === query.type : true))
          .map((wf) => withLayers(wf))
      : [];

    const items = [...builtin, ...dbDefinitions];
    return { items, total: items.length };
  });

  /** 内置工作流模板（前端「快速开始」入口使用） */
  app.get('/builtin', async () => {
    const items = Object.entries(BUILTIN_WORKFLOWS).map(([contentType, wf]) => ({
      contentType,
      definition: wf ? withLayers(wf) : null,
    }));
    return { items, total: items.length };
  });

  /** 工作流详情 */
  app.get('/:id', async (request) => {
    const id = parseIdParam(request);

    const row = await prisma.workflow.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundError(`工作流 ${id} 不存在`, { resourceLabel: '工作流', context: { workflowId: id } });
    }

    return withLayers(rowToDefinition(row));
  });

  /**
   * 创建工作流。
   *
   * 允许 Agent 动态规划出的流程持久化（origin=agent_planned），
   * 因此这里**不做「只允许内置流程」的限制** —— 但要严格校验 DAG 合法性。
   */
  app.post('/', async (request, reply) => {
    const input = parseBody(
      request,
      z.object({
        projectId: z.string().min(1).max(64).optional(),
        // 使用「形状 Schema」而非完整定义：完整定义带 superRefine，
        // 是 ZodEffects，不支持 .omit()。id 在形状 Schema 中本就是可选。
        definition: workflowDefinitionShapeSchema,
        isTemplate: z.boolean().default(false),
      }),
    );

    // 校验 DAG（含环检测、悬空依赖、重复 key），失败即拒绝
    const parsed = workflowDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) {
      throw new WorkflowInvalidError(
        `流程定义不合法：${parsed.error.issues.map((i) => i.message).join('；')}`,
        { suggestions: ['检查节点依赖是否形成环', '检查依赖的节点是否存在'] },
      );
    }

    const created = await prisma.workflow.create({
      data: {
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        type: parsed.data.type,
        name: parsed.data.name,
        description: parsed.data.description,
        version: parsed.data.version,
        origin: parsed.data.origin,
        nodes: parsed.data.nodes as never,
        edges: parsed.data.edges as never,
        metadata: parsed.data.metadata as never,
        isTemplate: input.isTemplate,
      },
    });

    return reply.status(201).send(withLayers(rowToDefinition(created)));
  });

  /**
   * 运行工作流。
   *
   * Phase 1 边界：**执行推进（Workflow Engine + Task Queue）属于 Phase 9**。
   * 本端点先完成「可运行性校验」并把运行记录落库为 pending 状态，
   * 明确返回尚未开始推进，而不是伪装成已启动。
   */
  app.post('/:id/run', async (request, reply) => {
    const id = parseIdParam(request);
    const input = parseBody(
      request,
      z.object({
        projectId: z.string().min(1).max(64),
        contentId: z.string().min(1).max(64).optional(),
        sessionId: z.string().min(1).max(64).optional(),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
    );

    const row = await prisma.workflow.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundError(`工作流 ${id} 不存在`, { resourceLabel: '工作流', context: { workflowId: id } });
    }

    const definition = rowToDefinition(row);
    const layers = topologicalLayers(definition.nodes);

    // 初始化运行状态：所有节点 pending，便于前端立刻画出进度骨架
    const nodes: Record<string, { key: string; state: string; attempts: number }> = {};
    for (const node of definition.nodes) {
      nodes[node.key] = { key: node.key, state: 'pending', attempts: 0 };
    }

    const run = await prisma.workflowRun.create({
      data: {
        workflowId: id,
        projectId: input.projectId,
        ...(input.contentId !== undefined ? { contentId: input.contentId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        status: 'pending',
        input: input.input as never,
        state: { nodes, currentLayer: 0, totalLayers: layers.length } as never,
        totalLayers: layers.length,
      },
    });

    return reply.status(201).send({
      runId: run.id,
      status: run.status,
      totalLayers: layers.length,
      layers,
      // 明确告知：运行记录已创建，但执行推进尚未接线
      note: '运行记录已创建。任务推进链路（Workflow Engine + Task Queue）将在 Phase 9 接通。',
    });
  });

  /** 工作流运行记录 */
  app.get('/:id/runs', async (request) => {
    const id = parseIdParam(request);
    const runs = await prisma.workflowRun.findMany({
      where: { workflowId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: runs, total: runs.length };
  });
}
