/**
 * 资产路由
 *
 * 对应技术文档第 74 条的 `/api/assets/*`。
 *
 * 本模块落实三条硬性要求：
 * 1. **统一 Asset System** —— 角色 / 产品 / 品牌 / 场景 / 数字人 / 素材共用一套接口，
 *    类型差异由 `metadata` 的判别联合承载（写入前必须按类型校验）。
 * 2. **必须支持版本** —— 每次变更写快照，可查看历史并恢复。
 * 3. **跨 Content 复用** —— 删除前检查引用，避免打断正在引用它的内容。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  assetSchema,
  AssetError,
  createAssetSchema,
  deepMerge,
  NotFoundError,
  paginate,
  paginationSchema,
  resolveAssetMetadata,
  slugSchema,
  updateAssetSchema,
  ValidationError,
  type PageBody,
} from '@svh/domain';
import {
  countAssetReferences,
  createAssetVersion,
  findAssetReferences,
  listAssetVersions,
  prisma,
  restoreAssetVersion,
} from '@svh/database';

import { ensureUniqueSlug, parseAssetMentions, slugifyAssetName } from '../core/slug.js';
import { getStorageDriver } from '../core/storage.js';
import { created, noContent, parseBody, parseIdParam, parseQuery } from '../core/validate.js';

/** 资产列表查询参数 */
const listAssetsQuerySchema = paginationSchema.extend({
  projectId: z.string().min(1).max(64).optional(),
  type: z.string().max(64).optional(),
  /** 按 slug 精确查询（@引用解析用） */
  slug: slugSchema.optional(),
  q: z.string().max(200).optional(),
  status: z.string().max(32).optional(),
});

/**
 * 把请求体合并为一份完整的资产数据，并**按类型校验 metadata**。
 *
 * 这是资产写入的唯一入口：任何路径（用户手动创建、Agent 生成、
 * Skill 产出）都必须经过它，从而保证 metadata 结构始终合法。
 */
function buildAssetData(input: {
  type: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): { type: string; name: string; description: string; metadata: Record<string, unknown> } {
  const parsed = assetSchema.safeParse({
    type: input.type,
    name: input.name,
    description: input.description ?? '',
    metadata: input.metadata ?? {},
  });

  if (!parsed.success) {
    // 把 Zod 的字段级问题转成用户可理解的提示。
    // 注意必须通过 userMessage 覆盖默认文案：ValidationError 的默认
    // userMessage 是通用的「提交的内容有问题」，会丢掉这里定位到的具体原因。
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    const detail = `${input.type} 类型的资产数据不合法：${issues.join('；')}`;
    throw new ValidationError(detail, {
      userMessage: detail,
      suggestions: issues.slice(0, 3),
      context: { assetType: input.type },
    });
  }

  return {
    type: parsed.data.type,
    name: parsed.data.name,
    description: parsed.data.description,
    metadata: parsed.data.metadata as Record<string, unknown>,
  };
}

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  /** 资产列表（供 @资产 面板与资产库使用） */
  app.get('/', async (request) => {
    const query = parseQuery(request, listAssetsQuerySchema);

    const where = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.slug ? { slug: query.slug } : {}),
      ...(query.status ? { status: query.status as never } : { status: { not: 'archived' as const } }),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { slug: { contains: query.q, mode: 'insensitive' as const } },
              { description: { contains: query.q, mode: 'insensitive' as const } },
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

    return paginate(items, total, query) satisfies PageBody<(typeof items)[number]>;
  });

  /** 创建资产 */
  app.post('/', async (request, reply) => {
    const input = parseBody(request, createAssetSchema);

    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundError(`项目 ${input.projectId} 不存在`, {
        context: { projectId: input.projectId },
      });
    }

    const data = buildAssetData(input);

    // slug 是 @引用 的键，必须项目内唯一
    const desiredSlug = input.slug ?? slugifyAssetName(input.name);
    const slug = await ensureUniqueSlug(desiredSlug, async (candidate) => {
      const found = await prisma.asset.findUnique({
        where: { projectId_slug: { projectId: input.projectId, slug: candidate } },
        select: { id: true },
      });
      return found !== null;
    });

    const asset = await prisma.$transaction(async (tx) => {
      const createdAsset = await tx.asset.create({
        data: {
          projectId: input.projectId,
          type: data.type as never,
          name: data.name,
          slug,
          description: data.description,
          metadata: data.metadata as never,
          tags: input.tags,
          files: input.files as never,
          ...(input.coverUrl !== undefined ? { coverUrl: input.coverUrl } : {}),
          ...(input.sourceContentId !== undefined
            ? { sourceContentId: input.sourceContentId }
            : {}),
        },
      });

      // 首版即 v1：让版本历史从创建那一刻开始完整
      const latest = await tx.assetVersion.findFirst({
        where: { assetId: createdAsset.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.assetVersion.create({
        data: {
          assetId: createdAsset.id,
          version: (latest?.version ?? 0) + 1,
          snapshot: {
            name: createdAsset.name,
            description: createdAsset.description,
            metadata: data.metadata,
            tags: createdAsset.tags,
            files: input.files,
            coverUrl: createdAsset.coverUrl,
            status: createdAsset.status,
          } as never,
          changelog: '创建资产',
        },
      });

      return createdAsset;
    });

    return created(reply, asset);
  });

  /** 资产详情（含引用计数，供「是否同步更新」判断） */
  app.get('/:id', async (request) => {
    const id = parseIdParam(request);

    const asset = await prisma.asset.findUnique({
      where: { id },
      include: { _count: { select: { versions: true, references: true } } },
    });
    if (!asset) {
      throw new AssetError('ASSET_NOT_FOUND', `资产 ${id} 不存在`, { context: { assetId: id } });
    }

    return asset;
  });

  /**
   * 资产媒体的存在性体检。
   *
   * ── 这个端点回答的是哪个问题 ──
   * 结果卡里的 `<img>` / `<video>` 打不开时，界面上有两种**完全不同**的原因，
   * 而浏览器的 `error` 事件分不出来：
   *   · 文件已经不在存储里了（被清理、磁盘问题、链接过期）；
   *   · 文件在，但浏览器解不了码或格式不支持。
   * 处置方式也不同：前者只能重新生成，后者重跑大概率还是同样结果。
   *
   * ── 为什么能可靠回答 ──
   * 产物落盘之后，`driver: 'local'` 的引用是**我们自己的**文件，查一下磁盘就知道 ——
   * 不需要网络探活，也就没有 SSRF 面。这正是把本地存储真正实现出来的第二个理由。
   *
   * `exists: null` 表示「不在我们手里，判不了」（provider 的 remote 链接）：
   * 界面据此退回中性文案，而不是猜一个结论。
   */
  app.get('/:id/media-health', async (request) => {
    const id = parseIdParam(request);

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, files: true },
    });
    if (!asset) {
      throw new AssetError('ASSET_NOT_FOUND', `资产 ${id} 不存在`, { context: { assetId: id } });
    }

    const files = Array.isArray(asset.files) ? asset.files : [];
    const driver = getStorageDriver();

    const items = await Promise.all(
      files.map(async (raw) => {
        const ref = (raw ?? {}) as { driver?: unknown; key?: unknown; url?: unknown };
        const key = typeof ref.key === 'string' ? ref.key : null;
        const url = typeof ref.url === 'string' ? ref.url : null;
        const refDriver = typeof ref.driver === 'string' ? ref.driver : 'unknown';

        if (refDriver !== 'local' || key === null) {
          // 不在我们手里：判不了，如实说「不知道」，不猜
          return { url, driver: refDriver, exists: null };
        }
        return { url, driver: refDriver, exists: (await driver.stat(key)).exists };
      }),
    );

    return { assetId: asset.id, items };
  });

  /** 更新资产（部分更新，metadata 深合并后按类型重新校验） */
  app.patch('/:id', async (request) => {
    const id = parseIdParam(request);
    const input = parseBody(request, updateAssetSchema);

    const existing = await prisma.asset.findUnique({ where: { id } });
    if (!existing) {
      throw new AssetError('ASSET_NOT_FOUND', `资产 ${id} 不存在`, { context: { assetId: id } });
    }

    // 注意：这里用「深合并后的完整对象」整体校验，而不是只校验补丁。
    // 两个原因：
    // 1. 判别联合要求 type 与 metadata 同时在场才能正确收窄，
    //    只校验补丁会退化成宽松类型，失去类型安全；
    // 2. 深合并保证「把发色改成红色」不会把年龄、脸型等其它字段抹掉 ——
    //    这是 Agent 做局部修改（技术文档第 48 条）的基础语义。
    const mergedMetadata =
      input.metadata !== undefined
        ? deepMerge(existing.metadata as Record<string, unknown>, input.metadata)
        : (existing.metadata as Record<string, unknown>);

    const data = buildAssetData({
      type: existing.type,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      metadata: mergedMetadata,
    });

    return prisma.$transaction(async (tx) => {
      await tx.asset.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description,
          metadata: data.metadata as never,
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.files !== undefined ? { files: input.files as never } : {}),
          ...(input.coverUrl !== undefined ? { coverUrl: input.coverUrl } : {}),
          ...(input.status !== undefined ? { status: input.status as never } : {}),
        },
      });

      const version = await createAssetVersion(id, {
        changelog: describeAssetChange(existing, data),
      });

      const updated = await tx.asset.findUniqueOrThrow({ where: { id } });
      return { ...updated, version };
    });
  });

  /** 归档资产（软删除）。被引用时拒绝，避免打断正在使用它的内容。 */
  app.delete('/:id', async (request, reply) => {
    const id = parseIdParam(request);

    const existing = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new AssetError('ASSET_NOT_FOUND', `资产 ${id} 不存在`, { context: { assetId: id } });
    }

    const referenceCount = await countAssetReferences(id);
    if (referenceCount > 0) {
      throw new AssetError(
        'ASSET_IN_USE',
        `资产被 ${referenceCount} 处引用，无法删除`,
        {
          context: { assetId: id, referenceCount },
          userMessage: `该资产正在被 ${referenceCount} 处内容引用，无法直接删除。`,
          suggestions: ['先解除这些引用再删除', '改为归档以保留历史'],
        },
      );
    }

    await prisma.asset.update({ where: { id }, data: { status: 'archived' } });
    return noContent(reply);
  });

  /** 版本历史（技术文档第 49 / 90 条） */
  app.get('/:id/versions', async (request) => {
    const id = parseIdParam(request);
    const versions = await listAssetVersions(id);
    return { items: versions, total: versions.length };
  });

  /** 恢复到指定版本（以新版本形式写入，历史只增不改） */
  app.post('/:id/versions/:version/restore', async (request) => {
    const params = request.params as { id?: string; version?: string };
    const id = params.id ?? '';
    const version = Number.parseInt(params.version ?? '', 10);

    if (!Number.isInteger(version) || version < 1) {
      throw new ValidationError('版本号必须是正整数');
    }

    const existing = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new AssetError('ASSET_NOT_FOUND', `资产 ${id} 不存在`, { context: { assetId: id } });
    }

    const newVersion = await restoreAssetVersion(id, version);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id } });
    return { ...asset, version: newVersion, restoredFrom: version };
  });

  /** 资产引用列表：回答「修改它需要同步更新几处」 */
  app.get('/:id/references', async (request) => {
    const id = parseIdParam(request);
    const references = await findAssetReferences(id);
    return { items: references, total: references.length };
  });

  /**
   * 解析 @引用。
   *
   * Agent 输入框把用户文本发到后端解析，换回真实资产 id，
   * 因此前端不需要自行维护「引用名 → id」的映射。
   */
  app.post('/resolve-mentions', async (request) => {
    const input = parseBody(
      request,
      z.object({
        projectId: z.string().min(1).max(64),
        text: z.string().min(1).max(20000),
      }),
    );

    const mentions = parseAssetMentions(input.text);
    if (mentions.length === 0) {
      return { mentions: [], matched: [], missing: [] };
    }

    const found = await prisma.asset.findMany({
      where: { projectId: input.projectId, slug: { in: mentions } },
      select: { id: true, slug: true, name: true, type: true, coverUrl: true },
    });

    const matchedSlugs = new Set(found.map((a) => a.slug));
    return {
      mentions,
      matched: found,
      missing: mentions.filter((m) => !matchedSlugs.has(m)),
    };
  });
}

/** 生成人类可读的变更说明，让版本历史对用户有意义 */
function describeAssetChange(
  before: { name: string; description: string; metadata: unknown },
  after: { name: string; description: string; metadata: Record<string, unknown> },
): string {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`名称：${before.name} → ${after.name}`);
  if (before.description !== after.description) parts.push('更新了描述');

  const beforeMeta = (before.metadata ?? {}) as Record<string, unknown>;
  const changedKeys = Object.keys(after.metadata).filter(
    (key) => JSON.stringify(beforeMeta[key]) !== JSON.stringify(after.metadata[key]),
  );
  if (changedKeys.length > 0) {
    parts.push(`更新字段：${changedKeys.join('、')}`);
  }

  return parts.length > 0 ? parts.join('；') : '内容更新';
}

/** 供其它模块复用的 metadata 校验入口 */
export { buildAssetData, resolveAssetMetadata };
