/**
 * 技能路由
 *
 * 对应技术文档第 76 条的 `/api/skills/*`。
 * 数据源是 `@svh/skills` 的代码目录；数据库中的 `skills` 表用于缓存与
 * 未来支持用户自定义技能，此处已做同步（seed 时写入）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  ConfirmationRequiredError,
  SkillNotFoundError,
} from '@svh/domain';
import { findSkillByAlias, getSkill, listSkills, SKILL_CATALOG } from '@svh/skills';
import { prisma } from '@svh/database';

import { parseQuery } from '../core/validate.js';

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
   * Phase 1 的明确边界：**本端点尚未接通 Worker 与 Model Router**。
   * 高成本技能直接返回「需要确认」的领域错误；
   * 其余技能返回 501 并说明当前进度，而不是假装成功。
   *
   * 这是刻意的选择：宁可明确报「未实现」，也不返回一个看似成功
   * 却什么都没做的响应 —— 后者会让前端与用户产生错误预期。
   */
  app.post('/:id/execute', async (request, reply) => {
    const params = request.params as { id?: string };
    const id = decodeURIComponent(params.id ?? '');

    const entry = getSkill(id);
    if (!entry) {
      throw new SkillNotFoundError(`技能 ${id} 不存在`, { context: { skillId: id } });
    }

    // 高成本技能即使功能未就绪，也要先走确认语义（保护用户额度）
    if (entry.definition.requiresConfirmation) {
      throw new ConfirmationRequiredError(`技能 ${id} 属于高成本操作，需要用户确认`, {
        context: { skillId: id, risk: entry.definition.risk },
        userMessage: `「${entry.definition.name}」属于高成本操作，需要你确认后才会执行。`,
        suggestions: ['确认后执行', '改为生成草稿'],
      });
    }

    return reply.status(501).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '技能执行链路正在开发中，当前版本尚未接通。',
        suggestions: ['当前版本可先浏览项目、内容与资产功能', '关注后续版本更新'],
        retryable: false,
      },
      requestId: request.id,
      // 明确告知当前阶段，避免前端误判为服务异常
      details: {
        skillId: id,
        queue: entry.queue,
        plannedPhase: 'Phase 2（Skill Registry 与 Worker 执行）',
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
