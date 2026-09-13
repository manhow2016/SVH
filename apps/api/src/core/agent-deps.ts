/**
 * Agent 依赖装配
 *
 * 把 `@svh/agent` 定义的端口用真实实现填满。这是**唯一**把数据库、
 * 模型层、任务系统与 Agent 绑在一起的地方 —— Agent 本身只依赖接口，
 * 因此可以脱离数据库做单测。
 */
import {
  buildModelRuntime,
  prisma,
  type ModelRuntime,
  type Prisma,
} from '@svh/database';
import { getEnv } from '@svh/config';
import { createDefaultSkillRegistry } from '@svh/skills';
import type { AgentDeps, AssetSummary } from '@svh/agent';
import { isCreativeAsset, MESSAGE_KINDS, type MessageKind } from '@svh/domain';

import { enqueueSkillTask } from './tasks.js';

import type { Logger } from './logger.js';

/**
 * 把 Fastify 的 pino logger 收窄成 `buildModelRuntime` 需要的那两个方法。
 *
 * 直接传 `request.log` 类型对不上：pino 的 `info` 是 `(obj, msg?, ...args)` 重载，
 * 而装配层要的是 `(msg, meta?)`。收窄放在这里，而不是让 `@svh/database`
 * 去认识 Fastify 的类型 —— 端口/适配器的边界不能倒过来。
 */
function toRuntimeLogger(log: Logger): {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
} {
  /** pino 的第一个参数必须是对象；meta 不是对象时包一层，别把字符串当成消息体 */
  const bag = (meta: unknown): Record<string, unknown> =>
    meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : meta === undefined ? {} : { meta };

  return {
    info: (msg, meta) => {
      log.info(bag(meta), msg);
    },
    warn: (msg, meta) => {
      log.warn(bag(meta), msg);
    },
  };
}

/** 把资产行压缩为一句摘要，供 Agent 理解 */
function describeAsset(type: string, name: string, description: string, metadata: unknown): string {
  const parts: string[] = [];
  if (description.length > 0) parts.push(description);

  const meta = metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};

  // 创意实体类资产把关键设定摊开，让 Agent 知道它是什么样
  if (isCreativeAsset(type as never)) {
    const appearance = meta.appearance;
    if (appearance !== null && typeof appearance === 'object') {
      const a = appearance as Record<string, unknown>;
      if (typeof a.hair === 'string') parts.push(`发型：${a.hair}`);
      if (typeof a.age === 'number') parts.push(`${a.age} 岁`);
      if (typeof a.vibe === 'string') parts.push(a.vibe);
    }
    if (typeof meta.role === 'string') parts.push(`定位：${meta.role}`);
    if (typeof meta.timeOfDay === 'string') parts.push(meta.timeOfDay);
    if (typeof meta.lighting === 'string') parts.push(meta.lighting);
    if (typeof meta.slogan === 'string') parts.push(`口号：${meta.slogan}`);
    if (typeof meta.category === 'string') parts.push(meta.category);
    const sellingPoints = meta.sellingPoints;
    if (Array.isArray(sellingPoints) && sellingPoints.length > 0) {
      parts.push(`卖点：${sellingPoints.slice(0, 3).join('、')}`);
    }
  }

  return parts.length > 0 ? parts.join('，') : name;
}

/** 资产行 → 摘要 */
function toAssetSummary(row: {
  id: string;
  slug: string;
  name: string;
  type: string;
  description: string;
  metadata: unknown;
}): AssetSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    summary: describeAsset(row.type, row.name, row.description, row.metadata),
  };
}

/**
 * 构造 Agent 依赖。
 *
 * 模型运行时每次调用时读取缓存的实例：Agent 对话是低频操作，
 * 而重建 Model Router 要查库并构造对象，不值得每次请求都做。
 *
 * ── 缓存的失效在谁手里 ──
 * 这个模块级缓存**不会自己过期**：改了 Provider 配置而没人调用
 * `invalidateAgentModelRuntime()` 的话，本进程会一直用启动时装配的那一份
 * （未配置模型时就是 Mock 回落），表现为「界面配好了模型，回复仍是占位文本」。
 * 因此 Provider 的写路径（`routes/providers.ts`）在每次非 GET 响应后统一失效它；
 * Worker 侧另有配置版本号轮询自行重建。**绕过 API 直接改库**（手写 SQL、
 * seed、另一个进程代改）不在失效范围内 —— 那种情况下必须重启 API。
 */
let cachedRuntime: ModelRuntime | null = null;

/**
 * 取模型运行时；首次（或缓存失效后首次）调用会重新装配。
 *
 * `logger` 只在**真的重新装配**那一次被用到，用来把 Mock 回落的警告打出来。
 * 这个参数此前根本不存在，于是 `buildModelRuntime` 里那句
 * 「数据库中没有可用的模型配置，已自动回落 Mock Provider」被 `options.logger?.warn`
 * 静默丢掉 —— 界面在用占位数据，日志里一个字都没有。
 */
export async function getAgentModelRuntime(logger?: Logger): Promise<ModelRuntime> {
  if (cachedRuntime === null) {
    cachedRuntime = await buildModelRuntime({
      encryptionKey: getEnv().SECRET_ENCRYPTION_KEY,
      ...(logger !== undefined ? { logger: toRuntimeLogger(logger) } : {}),
    });
  }
  return cachedRuntime;
}

/**
 * 使模型运行时缓存失效（Provider 配置变更后调用）。
 *
 * 下一次 `getAgentModelRuntime()` 会重新查库装配。
 * 在途的 Agent 轮次持有的是调用时的那个 runtime 对象，因此不会被打断。
 */
export function invalidateAgentModelRuntime(): void {
  cachedRuntime = null;
}

/** 构造 Agent 依赖 */
/**
 * 构造 Agent 依赖。
 *
 * `logger` 会一路传到模型运行时装配，用于把 Mock 回落警告落进 API 日志 ——
 * 「静默回落」的另一半是不吭声，日志与界面必须至少有一处说清楚。
 */
export async function buildAgentDeps(logger?: Logger): Promise<AgentDeps> {
  const runtime = await getAgentModelRuntime(logger);
  const registry = createDefaultSkillRegistry();

  return {
    projects: {
      getMemory: async (projectId) => {
        const row = await prisma.project.findUnique({
          where: { id: projectId },
          select: { memory: true },
        });
        return (row?.memory ?? {}) as Record<string, unknown>;
      },

      getProject: async (projectId) => {
        const row = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true, name: true, description: true },
        });
        return row;
      },

      mergeMemory: async (projectId, patch) => {
        const row = await prisma.project.findUnique({
          where: { id: projectId },
          select: { memory: true },
        });
        const merged = { ...((row?.memory ?? {}) as Record<string, unknown>), ...patch };
        await prisma.project.update({
          where: { id: projectId },
          data: { memory: merged as Prisma.InputJsonValue },
        });
      },
    },

    assets: {
      findBySlugs: async (projectId, slugs) => {
        if (slugs.length === 0) return [];
        const rows = await prisma.asset.findMany({
          where: { projectId, slug: { in: slugs }, status: { not: 'archived' } },
          select: {
            id: true, slug: true, name: true, type: true, description: true, metadata: true,
          },
        });
        return rows.map(toAssetSummary);
      },

      listSummaries: async (projectId, filter) => {
        const rows = await prisma.asset.findMany({
          where: {
            projectId,
            status: { not: 'archived' },
            ...(filter?.type !== undefined ? { type: filter.type as never } : {}),
          },
          select: {
            id: true, slug: true, name: true, type: true, description: true, metadata: true,
          },
          take: filter?.limit ?? 50,
          // 创意实体优先：它们是 Agent 规划时最需要的上下文
          orderBy: [{ type: 'asc' }, { updatedAt: 'desc' }],
        });
        return rows.map(toAssetSummary);
      },

      search: async (projectId, query, filter) => {
        const rows = await prisma.asset.findMany({
          where: {
            projectId,
            status: { not: 'archived' },
            ...(filter?.type !== undefined ? { type: filter.type as never } : {}),
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { slug: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true, slug: true, name: true, type: true, description: true, metadata: true,
          },
          take: filter?.limit ?? 10,
        });
        return rows.map(toAssetSummary);
      },
    },

    contents: {
      get: async (contentId) => {
        const row = await prisma.content.findUnique({
          where: { id: contentId },
          select: {
            id: true, type: true, title: true, brief: true, status: true, metadata: true,
          },
        });
        if (row === null) return null;
        return {
          id: row.id,
          type: row.type,
          title: row.title,
          brief: row.brief,
          status: row.status,
          metadata: (row.metadata ?? {}) as Record<string, unknown>,
        };
      },

      list: async (projectId, filter) => {
        const rows = await prisma.content.findMany({
          where: {
            projectId,
            ...(filter?.status !== undefined ? { status: filter.status as never } : {}),
          },
          select: { id: true, type: true, title: true, status: true, updatedAt: true },
          take: filter?.limit ?? 20,
          orderBy: { updatedAt: 'desc' },
        });
        return rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          status: r.status,
          updatedAt: r.updatedAt.toISOString(),
        }));
      },

      create: async (input) => {
        const row = await prisma.content.create({
          data: {
            projectId: input.projectId,
            type: input.type as never,
            title: input.title,
            brief: input.brief ?? '',
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          },
          select: { id: true, type: true, title: true },
        });
        return row;
      },
    },

    sessions: {
      recentMessages: async (sessionId, limit) => {
        const rows = await prisma.sessionMessage.findMany({
          where: { sessionId },
          select: { role: true, content: true, kind: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        // 查询是倒序（取最近的），回喂给模型时要恢复正序
        return rows.reverse().map((r) => ({
          role: r.role,
          content: r.content,
          kind: r.kind,
          createdAt: r.createdAt.toISOString(),
        }));
      },

      appendMessage: async (input) => {
        // kind 在端口侧是宽松字符串（Agent 只关心语义），
        // 落库前收敛为领域枚举；未知值退回 text，避免写入非法枚举
        const kind = (MESSAGE_KINDS as readonly string[]).includes(input.kind)
          ? (input.kind as MessageKind)
          : 'text';

        await prisma.sessionMessage.create({
          data: {
            sessionId: input.sessionId,
            role: input.role,
            direction: input.direction,
            kind,
            content: input.content,
            ...(input.payload !== undefined ? { payload: input.payload as Prisma.InputJsonValue } : {}),
            ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls as Prisma.InputJsonValue } : {}),
            ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
            ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          },
        });
      },

      updateState: async (sessionId, patch) => {
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            ...(patch.agentState !== undefined ? { agentState: patch.agentState } : {}),
            ...(patch.contextSnapshot !== undefined
              ? { contextSnapshot: patch.contextSnapshot as Prisma.InputJsonValue }
              : {}),
          },
        });
      },

      ensureSession: async (input) => {
        if (input.sessionId !== null && input.sessionId !== undefined && input.sessionId.length > 0) {
          const existing = await prisma.session.findUnique({
            where: { id: input.sessionId },
            select: { id: true },
          });
          if (existing !== null) return { id: existing.id, created: false };
        }

        const created = await prisma.session.create({
          data: {
            projectId: input.projectId,
            ...(input.contentId != null ? { contentId: input.contentId } : {}),
            title: input.title ?? '新会话',
            agentState: 'idle',
          },
          select: { id: true },
        });
        return { id: created.id, created: true };
      },
    },

    skills: {
      listImplemented: () =>
        registry.listImplemented().map((entry) => ({
          id: entry.definition.id,
          name: entry.definition.name,
          description: entry.definition.description,
          category: entry.definition.category,
          risk: entry.definition.risk,
          accessTier: entry.definition.accessTier,
          capabilities: entry.definition.capabilities,
          aliases: entry.definition.aliases,
          ...(entry.definition.userHint !== undefined ? { userHint: entry.definition.userHint } : {}),
        })),
    },

    tasks: {
      enqueue: async (input) => {
        const result = await enqueueSkillTask({
          skillId: input.skillId,
          projectId: input.projectId,
          input: input.input,
          contentId: input.contentId ?? null,
          sessionId: input.sessionId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          ...(input.initialStatus !== undefined ? { initialStatus: input.initialStatus } : {}),
        });
        return {
          taskId: result.taskId,
          status: result.status,
          deduplicated: result.deduplicated,
        };
      },
    },

    models: {
      generateText: async (input) => {
        const result = await runtime.router.invoke(
          {
            capability: 'text',
            prompt: input.prompt,
            params: {
              ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            },
            referenceImages: [],
            ...(input.responseSchema !== undefined ? { responseSchema: input.responseSchema } : {}),
          },
          {
            taskId: input.taskId ?? null,
            skillId: input.skillId ?? 'agent',
          },
        );

        return {
          text: result.text ?? '',
          ...(result.data !== undefined ? { data: result.data } : {}),
          modelId: result.modelId,
          ...(result.fallbackNote !== undefined ? { fallbackNote: result.fallbackNote } : {}),
        };
      },
    },
  };
}
