/**
 * 任务路由
 *
 * 对应技术文档第 73 条的 `/api/tasks/*`。
 *
 * 设计要点：**任务查询是 Agent UI 的主数据源**。
 * 前端通过 `GET /api/tasks/:id` 轮询进度（Phase 5 会换成 SSE 推送），
 * 因此响应里包含前端渲染进度条与结果卡片所需的全部字段。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  isTerminalTaskStatus,
  NotFoundError,
  paginate,
  TASK_STATUSES,
  type PageBody,
  type TaskStatusValue,
} from '@svh/domain';
import { cancelTask, prisma } from '@svh/database';

import { publishSessionEvent } from '../core/events.js';
import { enqueueSkillTask, requeueTask } from '../core/tasks.js';
import { parseBody, parseIdParam, parseQuery } from '../core/validate.js';
import { created, noContent } from '../core/validate.js';

/** 任务列表查询参数 */
const listTasksQuerySchema = z.object({
  projectId: z.string().min(1).max(64).optional(),
  contentId: z.string().min(1).max(64).optional(),
  sessionId: z.string().min(1).max(64).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  skillId: z.string().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** 手动创建任务（`/技能` 菜单与 Agent 工具调用共用） */
const createTaskSchema = z.object({
  projectId: z.string().min(1).max(64),
  skillId: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()).default({}),
  contentId: z.string().min(1).max(64).optional(),
  sessionId: z.string().min(1).max(64).optional(),
  /** 显式幂等键；不传则由服务端按输入内容生成 */
  idempotencyKey: z.string().max(200).optional(),
});

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  /** 任务列表 */
  app.get('/', async (request) => {
    const query = parseQuery(request, listTasksQuerySchema);

    const where = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.contentId ? { contentId: query.contentId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.skillId ? { skillId: query.skillId } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.agentTask.findMany({
        where,
        orderBy: { createdAt: query.sortOrder },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.agentTask.count({ where }),
    ]);

    return paginate(items, total, query) satisfies PageBody<(typeof items)[number]>;
  });

  /**
   * 创建任务并入队。
   *
   * 返回 **202 Accepted**：任务已受理但尚未完成。
   * 这是「Agent 不阻塞 HTTP 请求」在协议层面的表达。
   */
  app.post('/', async (request, reply) => {
    const input = parseBody(request, createTaskSchema);

    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundError(`项目 ${input.projectId} 不存在`, {
        resourceLabel: '项目',
        context: { projectId: input.projectId },
      });
    }

    const result = await enqueueSkillTask({
      skillId: input.skillId,
      projectId: input.projectId,
      input: input.input,
      contentId: input.contentId ?? null,
      sessionId: input.sessionId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    return created(reply.status(202), {
      taskId: result.taskId,
      status: result.status,
      jobId: result.jobId,
      queueName: result.queueName,
      /** 幂等命中时为 true，前端据此提示「已在处理中」而不是新建 */
      deduplicated: result.deduplicated,
    });
  });

  /** 任务详情（含进度、产出与子步骤轨迹） */
  app.get('/:id', async (request) => {
    const id = parseIdParam(request);

    const task = await prisma.agentTask.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { index: 'asc' } },
        attemptsLog: { orderBy: { attempt: 'asc' } },
        _count: { select: { modelTasks: true } },
      },
    });

    if (!task) {
      throw new NotFoundError(`任务 ${id} 不存在`, {
        resourceLabel: '任务',
        context: { taskId: id },
      });
    }

    return task;
  });

  /**
   * 轻量进度查询。
   *
   * 前端轮询进度时用这个而不是详情接口：不返回 steps / attemptsLog，
   * 数据量小一个数量级。响应中带 `terminal` 让前端知道何时停止轮询。
   */
  app.get('/:id/progress', async (request) => {
    const id = parseIdParam(request);

    const task = await prisma.agentTask.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        progress: true,
        progressMessage: true,
        errorMessage: true,
        skillId: true,
        updatedAt: true,
      },
    });

    if (!task) {
      throw new NotFoundError(`任务 ${id} 不存在`, {
        resourceLabel: '任务',
        context: { taskId: id },
      });
    }

    return {
      ...task,
      terminal: isTerminalTaskStatus(task.status as TaskStatusValue),
    };
  });

  /** 取消任务 */
  app.post('/:id/cancel', async (request, reply) => {
    const id = parseIdParam(request);
    const body = parseBody(
      request,
      z.object({ reason: z.string().max(500).optional() }).default({}),
    );

    const task = await prisma.agentTask.findUnique({
      where: { id },
      select: { status: true, sessionId: true },
    });
    if (!task) {
      throw new NotFoundError(`任务 ${id} 不存在`, {
        resourceLabel: '任务',
        context: { taskId: id },
      });
    }

    if (isTerminalTaskStatus(task.status as TaskStatusValue)) {
      // 已结束的任务取消是无意义操作，明确告知而不是静默成功
      throw new NotFoundError(`任务 ${id} 已结束，无法取消`, {
        resourceLabel: '可取消的任务',
        context: { taskId: id, status: task.status },
        userMessage: '该任务已经结束，无需取消。',
        suggestions: ['刷新查看最新状态'],
      });
    }

    const cancelled = await cancelTask(id, body.reason);
    if (!cancelled) {
      throw new NotFoundError(`任务 ${id} 取消失败（状态已变化）`, {
        resourceLabel: '可取消的任务',
        context: { taskId: id },
        userMessage: '任务状态已变化，取消未生效。',
        suggestions: ['刷新查看最新状态'],
      });
    }

    /*
     * 广播终态，使用户的会话流无需刷新就能看到「已取消」。
     *
     * 取消是 Worker 之外**唯一**的任务**终态**写入点（确认放行与重试同样会写
     * 状态，但写的是 `pending` 这个非终态）：不播的话，正在通过 SSE
     * 跟踪该任务的前端会一直停在 running，直到用户自己刷新。
     *
     * publishSessionEvent 契约上不抛异常（失败返回 null 并记日志），
     * 因此发布失败绝不会影响已经生效的取消操作。
     */
    await publishSessionEvent(task.sessionId, 'task.status', {
      taskId: id,
      status: 'cancelled',
      ...(body.reason !== undefined ? { message: body.reason } : {}),
    });

    return noContent(reply);
  });

  /** 重试任务（把失败的尝试重新入队） */
  app.post('/:id/retry', async (request) => {
    const id = parseIdParam(request);

    const task = await prisma.agentTask.findUnique({ where: { id }, select: { id: true } });
    if (!task) {
      throw new NotFoundError(`任务 ${id} 不存在`, {
        resourceLabel: '任务',
        context: { taskId: id },
      });
    }

    const result = await requeueTask(id);
    if (!result.enqueued) {
      return { retried: false, reason: result.reason };
    }

    return { retried: true };
  });

  /** 任务产出的资产（Agent UI 用它渲染结果卡片） */
  app.get('/:id/assets', async (request) => {
    const id = parseIdParam(request);

    const task = await prisma.agentTask.findUnique({
      where: { id },
      select: { output: true, projectId: true },
    });
    if (!task) {
      throw new NotFoundError(`任务 ${id} 不存在`, {
        resourceLabel: '任务',
        context: { taskId: id },
      });
    }

    const output = (task.output ?? {}) as { producedAssetIds?: string[]; assetId?: string };
    const ids = [
      ...(output.producedAssetIds ?? []),
      ...(output.assetId !== undefined ? [output.assetId] : []),
    ];

    if (ids.length === 0) return { items: [], total: 0 };

    const assets = await prisma.asset.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: { _count: { select: { versions: true } } },
    });

    return { items: assets, total: assets.length };
  });
}
