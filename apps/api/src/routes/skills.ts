/**
 * 技能路由
 *
 * 对应技术文档第 76 条的 `/api/skills/*`。
 * 数据源是 `@svh/skills` 的代码目录；数据库中的 `skills` 表用于缓存与
 * 未来支持用户自定义技能，此处已做同步（seed 时写入）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { NotFoundError, SkillNotFoundError } from '@svh/domain';
import { findSkillByAlias, getSkill, listSkills, SKILL_CATALOG } from '@svh/skills';
import { prisma } from '@svh/database';

import { buildIdempotencyKey, enqueueSkillTask } from '../core/tasks.js';
import { parseBody, parseQuery } from '../core/validate.js';

/** 技能列表筛选 */
const listSkillsQuerySchema = z.object({
  category: z.string().max(64).optional(),
  capability: z.string().max(64).optional(),
  tier: z.enum(['free', 'pro', 'enterprise']).optional(),
  /** 是否包含内部技能（对用户隐藏的） */
  includeHidden: z.coerce.boolean().default(false),
});

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  /** 技能列表（供 `/技能` 菜单与设置页展示） */
  app.get('/', async (request) => {
    const query = parseQuery(request, listSkillsQuerySchema);

    const items = SKILL_CATALOG.filter((entry) => {
      const d = entry.definition;
      if (!query.includeHidden && d.hidden) return false;
      if (query.category && d.category !== query.category) return false;
      if (query.tier && d.accessTier !== query.tier) return false;
      // 能力筛选按 capabilities 字段判断，而不是靠 id 里是否含关键词 ——
      // 后者会把 advertisement.generate（能力为 video）之类的技能漏掉。
      if (query.capability && !(d.capabilities as readonly string[]).includes(query.capability)) {
        return false;
      }
      return true;
    }).map((entry) => ({
      ...entry.definition,
      queue: entry.queue,
    }));

    return { items, total: items.length };
  });

  /** 能力 → 可用技能的映射（Model Router 选模前的能力清单） */
  app.get('/capabilities', async () => {
    const byCapability = new Map<string, string[]>();
    for (const entry of SKILL_CATALOG) {
      for (const capability of entry.definition.capabilities) {
        const list = byCapability.get(capability) ?? [];
        list.push(entry.definition.id);
        byCapability.set(capability, list);
      }
    }
    return {
      items: [...byCapability.entries()].map(([capability, skillIds]) => ({
        capability,
        skillIds,
        count: skillIds.length,
      })),
    };
  });

  /** 技能分类汇总（用于菜单分组） */
  app.get('/categories', async () => {
    const byCategory = new Map<string, { category: string; count: number; skills: string[] }>();
    for (const entry of SKILL_CATALOG) {
      const { category, id, hidden } = entry.definition;
      if (hidden) continue;
      const bucket = byCategory.get(category) ?? { category, count: 0, skills: [] };
      bucket.count += 1;
      bucket.skills.push(id);
      byCategory.set(category, bucket);
    }
    return { items: [...byCategory.values()] };
  });

  /** 技能详情 */
  app.get('/:id', async (request) => {
    // 技能 id 含点号（如 image.generate），Fastify 的 :id 能正确匹配
    const params = request.params as { id?: string };
    const id = decodeURIComponent(params.id ?? '');

    const entry = getSkill(id);
    if (!entry) {
      throw new SkillNotFoundError(`技能 ${id} 不存在`, { context: { skillId: id } });
    }

    return { ...entry.definition, queue: entry.queue };
  });

  /**
   * 按中文别名查找技能。
   * 供 Agent 输入框的 `/技能` 指令使用（如 `/写脚本`）。
   */
  app.get('/by-alias/:alias', async (request) => {
    const params = request.params as { alias?: string };
    const alias = decodeURIComponent(params.alias ?? '');

    const definition = findSkillByAlias(alias);
    if (!definition) {
      throw new SkillNotFoundError(`没有找到别名「${alias}」对应的技能`, {
        suggestions: ['在 /技能 菜单中选择一个技能'],
      });
    }

    const entry = getSkill(definition.id);
    return { ...definition, queue: entry?.queue };
  });

  /**
   * 执行技能。
   *
   * 返回 **202 Accepted** 而不是 200：任务已受理但**尚未完成**。
   * 这是「Agent 不阻塞 HTTP 请求」（技术文档第 42 条）在协议层面的表达 ——
   * 客户端拿到 taskId 后通过 `/api/tasks/:id/progress` 轮询或 SSE 订阅进度。
   *
   * 高成本技能不会在这里被拒绝：它们会被创建为任务，由 Worker 置为
   * `waiting_user` 并回传确认请求。这样「确认」这件事统一由任务状态机表达，
   * 而不是在多个入口各写一套判断。
   */
  app.post('/:id/execute', async (request, reply) => {
    const params = request.params as { id?: string };
    const id = decodeURIComponent(params.id ?? '');

    const entry = getSkill(id);
    if (entry === undefined) {
      throw new SkillNotFoundError(`技能 ${id} 不存在`, { context: { skillId: id } });
    }

    const input = parseBody(
      request,
      z.object({
        projectId: z.string().min(1).max(64),
        input: z.record(z.string(), z.unknown()).default({}),
        contentId: z.string().min(1).max(64).optional(),
        sessionId: z.string().min(1).max(64).optional(),
        idempotencyKey: z.string().max(200).optional(),
      }),
    );

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
      skillId: id,
      projectId: input.projectId,
      input: input.input,
      contentId: input.contentId ?? null,
      sessionId: input.sessionId ?? null,
      // 未显式提供幂等键时按「技能 + 内容 + 输入」自动生成，
      // 使重复点击不会产生重复扣费
      idempotencyKey:
        input.idempotencyKey ??
        buildIdempotencyKey({
          skillId: id,
          projectId: input.projectId,
          contentId: input.contentId ?? null,
          payload: input.input,
        }),
    });

    return reply.status(202).send({
      taskId: result.taskId,
      status: result.status,
      queueName: result.queueName,
      jobId: result.jobId,
      deduplicated: result.deduplicated,
      skill: {
        id: entry.definition.id,
        name: entry.definition.name,
        risk: entry.definition.risk,
        requiresConfirmation: entry.definition.requiresConfirmation,
      },
    });
  });

  /**
   * 同步技能目录到数据库。
   *
   * `skills` 表用于持久化技能元数据，便于做权限配置与执行记录外键。
   * 代码目录是唯一事实来源，本端点负责把它们对齐。
   */
  app.post('/sync', async () => {
    const definitions = listSkills();

    const results = await Promise.all(
      definitions.map((definition) =>
        prisma.skill.upsert({
          where: { id: definition.id },
          create: {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            version: definition.version,
            category: definition.category,
            capabilities: definition.capabilities as string[],
            inputSchema: definition.inputSchema as never,
            outputSchema: definition.outputSchema as never,
            risk: definition.risk,
            accessTier: definition.accessTier,
            estimatedSeconds: definition.estimatedSeconds ?? 0,
            cancellable: definition.cancellable,
            retryable: definition.retryable,
            requiresConfirmation: definition.requiresConfirmation,
            aliases: definition.aliases,
            ...(definition.userHint !== undefined ? { userHint: definition.userHint } : {}),
            hidden: definition.hidden,
          },
          update: {
            name: definition.name,
            description: definition.description,
            version: definition.version,
            category: definition.category,
            capabilities: definition.capabilities as string[],
            inputSchema: definition.inputSchema as never,
            outputSchema: definition.outputSchema as never,
            risk: definition.risk,
            accessTier: definition.accessTier,
            estimatedSeconds: definition.estimatedSeconds ?? 0,
            cancellable: definition.cancellable,
            retryable: definition.retryable,
            requiresConfirmation: definition.requiresConfirmation,
            aliases: definition.aliases,
            userHint: definition.userHint ?? null,
            hidden: definition.hidden,
          },
        }),
      ),
    );

    return { synced: results.length, skillIds: results.map((r) => r.id) };
  });
}
