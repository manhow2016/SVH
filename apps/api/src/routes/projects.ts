/**
 * 项目路由
 *
 * 对应技术文档第 70 条的 `/api/projects/*`。
 * 成功响应直接返回资源（201 / 200 / 204），不使用统一包装 —— 见 transport.ts 的说明。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createContentSchema,
  createProjectSchema,
  NotFoundError,
  paginate,
  paginationSchema,
  updateProjectSchema,
  type PageBody,
} from '@svh/domain';
import { prisma, type AssetType, type Prisma } from '@svh/database';

import { created, noContent, parseBody, parseIdParam, parseQuery } from '../core/validate.js';

/** 项目列表查询参数 */
const listProjectsQuerySchema = paginationSchema.extend({
  q: z.string().max(200).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  /** 项目列表 */
  app.get('/', async (request) => {
    const query = parseQuery(request, listProjectsQuerySchema);

    const where = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.project.findMany({
        where,
        orderBy: { updatedAt: query.sortOrder },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.project.count({ where }),
    ]);

    return paginate(items, total, query) satisfies PageBody<(typeof items)[number]>;
  });

  /** 创建项目 */
  app.post('/', async (request, reply) => {
    const input = parseBody(request, createProjectSchema);

    const project = await prisma.project.create({
      data: {
        name: input.name,
        description: input.description,
        memory: (input.memory ?? {}) as Prisma.InputJsonValue,
      },
    });

    return created(reply, project);
  });

  /** 项目详情 */
  app.get('/:id', async (request) => {
    const id = parseIdParam(request);

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        _count: { select: { contents: true, assets: true, sessions: true } },
      },
    });

    if (!project) {
      throw new NotFoundError(`项目 ${id} 不存在`, { resourceLabel: '项目', context: { projectId: id } });
    }

    return project;
  });

  /** 更新项目（含 Project Memory） */
  app.patch('/:id', async (request) => {
    const id = parseIdParam(request);
    const input = parseBody(request, updateProjectSchema);

    const existing = await prisma.project.findUnique({ where: { id }, select: { memory: true } });
    if (!existing) {
      throw new NotFoundError(`项目 ${id} 不存在`, { resourceLabel: '项目', context: { projectId: id } });
    }

    // Project Memory 采用浅合并：Agent 每次只更新自己负责的片段，
    // 不应把其它片段抹掉。深层结构由 projectMemorySchema.partial() 保证。
    const mergedMemory = {
      ...(existing.memory as Record<string, unknown>),
      ...(input.memory ?? {}),
    };

    return prisma.project.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.memory !== undefined ? { memory: mergedMemory as Prisma.InputJsonValue } : {}),
        ...(input.archived !== undefined
          ? { archivedAt: input.archived ? new Date() : null }
          : {}),
      },
    });
  });

  /** 归档项目（软删除） */
  app.delete('/:id', async (request, reply) => {
    const id = parseIdParam(request);

    const existing = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new NotFoundError(`项目 ${id} 不存在`, { resourceLabel: '项目', context: { projectId: id } });
    }

    // 软删除：项目下挂着内容、资产与版本历史，物理删除会丢历史
    await prisma.project.update({ where: { id }, data: { archivedAt: new Date() } });
    return noContent(reply);
  });

  /** 项目下的内容列表 */
  app.get('/:id/contents', async (request) => {
    const projectId = parseIdParam(request);
    const query = parseQuery(request, paginationSchema);

    const where = { projectId };
    const [items, total] = await Promise.all([
      prisma.content.findMany({
        where,
        orderBy: { updatedAt: query.sortOrder },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.content.count({ where }),
    ]);

    return paginate(items, total, query);
  });

  /** 在项目下创建内容 */
  app.post('/:id/contents', async (request, reply) => {
    const projectId = parseIdParam(request);
    const input = parseBody(request, createContentSchema.omit({ projectId: true }));

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundError(`项目 ${projectId} 不存在`, { resourceLabel: '项目', context: { projectId } });
    }

    const content = await prisma.content.create({
      data: {
        projectId,
        type: input.type,
        title: input.title,
        brief: input.brief,
        metadata: input.metadata as Prisma.InputJsonValue,
        ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
      },
    });

    return created(reply, content);
  });

  /** 项目下的资产列表（支持按类型筛选，供 @资产 面板使用） */
  app.get('/:id/assets', async (request) => {
    const projectId = parseIdParam(request);
    const query = parseQuery(
      request,
      paginationSchema.extend({
        type: z.string().max(64).optional(),
        q: z.string().max(200).optional(),
      }),
    );

    const where = {
      projectId,
      ...(query.type ? { type: query.type as AssetType } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { slug: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { updatedAt: query.sortOrder },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.asset.count({ where }),
    ]);

    return paginate(items, total, query);
  });
}
