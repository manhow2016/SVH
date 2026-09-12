/**
 * Agent 对话路由
 *
 * 对应技术文档第 71 条的 `POST /api/agent/chat`。
 *
 * ── 与普通聊天接口的区别 ──
 * 这个接口不是「发消息、拿回复」那么简单：一次调用可能
 * 创建内容、提交任务、装配上下文，因此响应里同时返回
 * **消息、结构化载荷、工具调用轨迹与上下文说明**。
 * 前端据此渲染计划清单、结果卡片，并让用户理解 Agent 做了什么。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  agentChatRequestSchema,
  NotFoundError,
  type MessagePayload,
  type PlanPayload,
} from '@svh/domain';
import { AgentRuntime, buildAgentTools } from '@svh/agent';
import { prisma, type Prisma } from '@svh/database';

import { buildAgentDeps } from '../core/agent-deps.js';
import { getQueuePool } from '../core/tasks.js';
import { parseBody, parseIdParam, parseQuery } from '../core/validate.js';

/** 会话列表查询 */
const listSessionsQuerySchema = z.object({
  projectId: z.string().min(1).max(64).optional(),
  contentId: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** 会话消息查询 */
const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** 只取某个时间点之前的消息（翻页用） */
  before: z.string().datetime().optional(),
});

/** 结构化日志器，接到 Fastify 的日志上 */
function createAgentLogger(app: FastifyInstance) {
  return {
    debug: (msg: string, meta?: unknown) => app.log.debug({ meta }, msg),
    info: (msg: string, meta?: unknown) => app.log.info({ meta }, msg),
    warn: (msg: string, meta?: unknown) => app.log.warn({ meta }, msg),
    error: (msg: string, meta?: unknown) => app.log.error({ meta }, msg),
  };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Agent 对话。
   *
   * 流程：确保会话存在 → 记录用户消息 → 运行 Agent 轮次 →
   * 记录 Agent 消息（含结构化载荷与工具轨迹）→ 返回结果。
   */
  app.post('/chat', async (request) => {
    const input = parseBody(request, agentChatRequestSchema);

    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, name: true },
    });
    if (project === null) {
      throw new NotFoundError(`项目 ${input.projectId} 不存在`, {
        resourceLabel: '项目',
        context: { projectId: input.projectId },
      });
    }

    const deps = await buildAgentDeps();

    // ── 确保会话存在 ──
    const session = await deps.sessions.ensureSession({
      sessionId: input.sessionId ?? null,
      projectId: input.projectId,
      contentId: input.contentId ?? null,
      title: input.message.slice(0, 40),
    });

    // ── 记录用户消息 ──
    await deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      direction: 'inbound',
      kind: 'text',
      content: input.message,
    });

    await deps.sessions.updateState(session.id, { agentState: 'thinking' });

    // ── 运行 Agent 轮次 ──
    const runtime = new AgentRuntime({
      deps,
      tools: buildAgentTools({ deps }),
      logger: createAgentLogger(app),
    });

    const controller = new AbortController();
    // 客户端断开时传导取消，避免 Agent 继续消耗模型调用
    request.raw.on('close', () => controller.abort());

    const result = await runtime.runTurn({
      projectId: input.projectId,
      sessionId: session.id,
      contentId: input.contentId ?? null,
      message: input.message,
      referencedAssetIds: input.referencedAssetIds,
      signal: controller.signal,
    });

    // ── 记录 Agent 消息（结构化载荷 + 工具轨迹）──
    await deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      direction: 'outbound',
      // 消息类型由载荷决定，前端据此选择渲染器
      kind: result.payload !== undefined ? (result.payload.type as string) : 'text',
      content: result.message,
      ...(result.payload !== undefined ? { payload: result.payload } : {}),
      ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
      tokens: result.estimatedTokens,
      ...(result.modelIds[0] !== undefined ? { modelId: result.modelIds[0] } : {}),
    });

    await deps.sessions.updateState(session.id, {
      agentState: result.state,
      contextSnapshot: {
        // 记录本次装配了哪些上下文，便于用户理解与排障
        notes: result.contextNotes,
        estimatedTokens: result.estimatedTokens,
        assetIds: [],
        contentIds: input.contentId !== undefined ? [input.contentId] : [],
        projectMemory: true,
        historyMessages: 0,
      },
    });

    return {
      sessionId: session.id,
      sessionCreated: session.created,
      message: result.message,
      ...(result.payload !== undefined ? { payload: result.payload } : {}),
      state: result.state,
      // 意图分析结果：让前端能展示「Agent 理解成了什么」
      analysis: {
        intent: result.analysis.intent,
        confidence: result.analysis.confidence,
        ...(result.analysis.contentType !== undefined
          ? { contentType: result.analysis.contentType }
          : {}),
        targets: result.analysis.targets,
        mentions: result.analysis.mentions,
        ...(result.analysis.rationale !== undefined ? { rationale: result.analysis.rationale } : {}),
      },
      toolCalls: result.toolCalls,
      contextNotes: result.contextNotes,
      iterations: result.iterations,
    };
  });

  /** 会话列表 */
  app.get('/sessions', async (request) => {
    const query = parseQuery(request, listSessionsQuerySchema);

    const where = {
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.contentId !== undefined ? { contentId: query.contentId } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.session.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { messages: true } } },
      }),
      prisma.session.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        contentId: row.contentId,
        title: row.title,
        agentState: row.agentState,
        status: row.status,
        messageCount: row._count.messages,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: query.page * query.pageSize < total,
    };
  });

  /** 会话详情（含消息） */
  app.get('/sessions/:id', async (request) => {
    const id = parseIdParam(request);
    const query = parseQuery(request, listMessagesQuerySchema);

    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        contentId: true,
        title: true,
        agentState: true,
        status: true,
        contextSnapshot: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (session === null) {
      throw new NotFoundError(`会话 ${id} 不存在`, {
        resourceLabel: '会话',
        context: { sessionId: id },
      });
    }

    const messages = await prisma.sessionMessage.findMany({
      where: {
        sessionId: id,
        ...(query.before !== undefined ? { createdAt: { lt: new Date(query.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return {
      ...session,
      // 返回时恢复时间正序，便于前端直接顺序渲染
      messages: messages.reverse(),
    };
  });

  /** 归档会话 */
  app.post('/sessions/:id/archive', async (request, reply) => {
    const id = parseIdParam(request);

    const updated = await prisma.session.updateMany({
      where: { id },
      data: { status: 'archived' },
    });
    if (updated.count === 0) {
      throw new NotFoundError(`会话 ${id} 不存在`, {
        resourceLabel: '会话',
        context: { sessionId: id },
      });
    }

    return reply.status(204).send();
  });

  /**
   * 确认并继续。
   *
   * 用于两个场景：
   * 1. 用户确认了 Agent 提出的计划 → 让 Agent 开始执行
   * 2. 用户确认了高成本操作 → 把停在 waiting_user 的任务放行
   *
   * 实现方式：把等待确认的任务重新入队（`waiting_user` → `pending`），
   * 并把这次确认作为一条用户消息记入会话，使上下文连贯。
   */
  app.post('/sessions/:id/confirm', async (request) => {
    const id = parseIdParam(request);
    const input = parseBody(
      request,
      z.object({
        /** 要放行的任务 id；不传则放行该会话下全部 waiting_user 任务 */
        taskIds: z.array(z.string().min(1).max(64)).max(50).default([]),
        /** 用户补充说明（可选） */
        note: z.string().max(2000).optional(),
      }),
    );

    const session = await prisma.session.findUnique({
      where: { id },
      select: { id: true, projectId: true },
    });
    if (session === null) {
      throw new NotFoundError(`会话 ${id} 不存在`, {
        resourceLabel: '会话',
        context: { sessionId: id },
      });
    }

    // 找出等待确认的任务
    const waiting = await prisma.agentTask.findMany({
      where: {
        sessionId: id,
        status: 'waiting_user',
        ...(input.taskIds.length > 0 ? { id: { in: input.taskIds } } : {}),
      },
      select: { id: true, attempts: true, maxAttempts: true, queueName: true },
    });

    const resumed: string[] = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];

    for (const task of waiting) {
      if (task.queueName === null) {
        skipped.push({ taskId: task.id, reason: '任务缺少队列信息' });
        continue;
      }
      if (task.attempts >= task.maxAttempts) {
        skipped.push({ taskId: task.id, reason: '尝试次数已耗尽' });
        continue;
      }

      // 状态从 waiting_user 回到 pending，使其重新可被抢占
      await prisma.agentTask.updateMany({
        where: { id: task.id, status: 'waiting_user' },
        data: {
          status: 'pending',
          progress: 0,
          progressMessage: null,
          error: null,
          errorMessage: null,
        },
      });

      await getQueuePool().enqueue({
        taskId: task.id,
        queueName: task.queueName,
        attempt: task.attempts + 1,
      });

      resumed.push(task.id);
    }

    // 记录确认动作，使会话上下文连贯
    await prisma.sessionMessage.create({
      data: {
        sessionId: id,
        role: 'user',
        direction: 'inbound',
        kind: 'text',
        content: input.note ?? '确认执行',
      },
    });

    return {
      resumed,
      skipped,
      message:
        resumed.length > 0
          ? `已确认 ${resumed.length} 个操作，正在继续执行。`
          : '没有等待确认的操作。',
    };
  });

  /** 会话的任务列表（Agent UI 用它展示当前进度） */
  app.get('/sessions/:id/tasks', async (request) => {
    const id = parseIdParam(request);

    const tasks = await prisma.agentTask.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        skillId: true,
        status: true,
        risk: true,
        progress: true,
        progressMessage: true,
        errorMessage: true,
        output: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { items: tasks, total: tasks.length };
  });
}

/** 供其它模块复用 */
export type { MessagePayload, PlanPayload };
export { Prisma };
