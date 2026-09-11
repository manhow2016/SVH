/**
 * 内容路由
 *
 * 对应技术文档第 75 条的 `/api/contents/*`。
 *
 * 关键设计：**左侧导航分区由内容类型动态决定**（技术文档第 58 条）。
 * 分区配置位于 `@svh/domain` 的 `CONTENT_SECTIONS`，是声明式数据而非
 * 散落的 `if (contentType === 'drama')` 分支。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  ContentError,
  CONTENT_SECTIONS,
  contentTypeSchema,
  getContentSections,
  NotFoundError,
  paginate,
  paginationSchema,
  updateContentSchema,
  type ContentType,
  type PageBody,
} from '@svh/domain';
import { prisma } from '@svh/database';

import { noContent, parseBody, parseIdParam, parseQuery } from '../core/validate.js';

/** 内容列表查询参数 */
const listContentsQuerySchema = paginationSchema.extend({
  projectId: z.string().min(1).max(64).optional(),
  type: contentTypeSchema.optional(),
  status: z.string().max(32).optional(),
  q: z.string().max(200).optional(),
});

/** 内容版本快照结构 */
const contentSnapshotSchema = z.object({
  title: z.string(),
  brief: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  status: z.string(),
});

export async function contentRoutes(app: FastifyInstance): Promise<void> {
  /** 内容列表 */
  app.get('/', async (request) => {
    const query = parseQuery(request, listContentsQuerySchema);

    const where = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.status ? { status: query.status as never } : { archivedAt: null }),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { brief: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.content.findMany({
        where,
        orderBy: { updatedAt: query.sortOrder },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.content.count({ where }),
    ]);

    return paginate(items, total, query) satisfies PageBody<(typeof items)[number]>;
  });

  /** 内容详情 */
  app.get('/:id', async (request) => {
    const id = parseIdParam(request);

    const content = await prisma.content.findUnique({
      where: { id },
      include: {
        _count: { select: { versions: true, tasks: true, outputs: true, workflowRuns: true } },
      },
    });
    if (!content) {
      throw new ContentError(`内容 ${id} 不存在`, { context: { contentId: id } });
    }

    return content;
  });

  /**
   * 内容的导航分区。
   *
   * 前端左侧导航据此渲染：广告显示「创意/产品/脚本/分镜/成片」，
   * 短剧显示「剧本/角色/场景/分集/分镜」，无需在前端硬编码类型判断。
   */
  app.get('/:id/sections', async (request) => {
    const id = parseIdParam(request);

    const content = await prisma.content.findUnique({
      where: { id },
      select: { id: true, type: true },
    });
    if (!content) {
      throw new ContentError(`内容 ${id} 不存在`, { context: { contentId: id } });
    }

    return { contentId: content.id, type: content.type, sections: getContentSections(content.type) };
  });

  /** 支持的导航分区全集（供前端做类型与图标映射） */
  app.get('/meta/sections', async () => {
    return { byType: CONTENT_SECTIONS };
  });

  /** 更新内容 */
  app.patch('/:id', async (request) => {
    const id = parseIdParam(request);
    const input = parseBody(request, updateContentSchema);

    const existing = await prisma.content.findUnique({ where: { id } });
    if (!existing) {
      throw new ContentError(`内容 ${id} 不存在`, { context: { contentId: id } });
    }

    // metadata 深合并：Agent 修改「时长」时不应把「平台」「受众」抹掉
    const mergedMetadata = {
      ...((existing.metadata ?? {}) as Record<string, unknown>),
      ...(input.metadata ?? {}),
    };

    return prisma.$transaction(async (tx) => {
      const updated = await tx.content.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.brief !== undefined ? { brief: input.brief } : {}),
          ...(input.metadata !== undefined ? { metadata: mergedMetadata as never } : {}),
          ...(input.status !== undefined ? { status: input.status as never } : {}),
          ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
        },
      });

      // 内容同样需要版本（技术文档第 49 条：所有生成内容必须支持版本）
      const latest = await tx.contentVersion.findFirst({
        where: { contentId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      await tx.contentVersion.create({
        data: {
          contentId: id,
          version: (latest?.version ?? 0) + 1,
          snapshot: contentSnapshotSchema.parse({
            title: updated.title,
            brief: updated.brief,
            metadata: (updated.metadata ?? {}) as Record<string, unknown>,
            status: updated.status,
          }) as never,
          changelog: describeContentChange(existing, input),
        },
      });

      return updated;
    });
  });

  /** 归档内容 */
  app.delete('/:id', async (request, reply) => {
    const id = parseIdParam(request);

    const existing = await prisma.content.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new ContentError(`内容 ${id} 不存在`, { context: { contentId: id } });
    }

    await prisma.content.update({ where: { id }, data: { archivedAt: new Date() } });
    return noContent(reply);
  });

  /** 内容版本历史 */
  app.get('/:id/versions', async (request) => {
    const id = parseIdParam(request);

    const versions = await prisma.contentVersion.findMany({
      where: { contentId: id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, changelog: true, sessionId: true, createdAt: true },
    });

    return { items: versions, total: versions.length };
  });

  /** 读取某个版本的完整快照（用于对比与恢复） */
  app.get('/:id/versions/:version', async (request) => {
    const params = request.params as { id?: string; version?: string };
    const id = params.id ?? '';
    const version = Number.parseInt(params.version ?? '', 10);

    const found = await prisma.contentVersion.findUnique({
      where: { contentId_version: { contentId: id, version } },
    });
    if (!found) {
      throw new NotFoundError(`内容 ${id} 不存在版本 v${version}`, {
          resourceLabel: '该内容版本',
        context: { contentId: id, version },
      });
    }

    return found;
  });

  /** 内容的输出物 */
  app.get('/:id/outputs', async (request) => {
    const id = parseIdParam(request);
    const outputs = await prisma.output.findMany({
      where: { contentId: id },
      orderBy: { createdAt: 'desc' },
    });
    return { items: outputs, total: outputs.length };
  });

  /** 内容的关联资产（含角色 / 场景 / 产品，供内容工作台右侧展示） */
  app.get('/:id/assets', async (request) => {
    const id = parseIdParam(request);
    const query = parseQuery(request, z.object({ type: z.string().max(64).optional() }));

    const refs = await prisma.assetReference.findMany({
      where: { contentId: id, ...(query.type ? { asset: { type: query.type as never } } : {}) },
      include: {
        asset: {
          select: { id: true, slug: true, name: true, type: true, coverUrl: true, status: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return { items: refs, total: refs.length };
  });
}

/** 生成人类可读的内容变更说明 */
function describeContentChange(
  before: { title: string; brief: string; metadata: unknown; status: string },
  patch: { title?: string; brief?: string; metadata?: Record<string, unknown>; status?: string },
): string {
  const parts: string[] = [];
  if (patch.title !== undefined && patch.title !== before.title) {
    parts.push(`标题：${before.title} → ${patch.title}`);
  }
  if (patch.status !== undefined && patch.status !== before.status) {
    parts.push(`状态：${before.status} → ${patch.status}`);
  }
  if (patch.brief !== undefined && patch.brief !== before.brief) parts.push('更新了需求描述');
  if (patch.metadata !== undefined) {
    parts.push(`更新字段：${Object.keys(patch.metadata).join('、')}`);
  }
  return parts.length > 0 ? parts.join('；') : '内容更新';
}

/** 供测试与其它模块复用 */
export type { ContentType };
