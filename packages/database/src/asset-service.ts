/**
 * 资产数据校验与持久化
 *
 * 为什么放在 database 包而不是 API 路由里：
 * 资产的写入路径有三条 —— 用户手动创建（API）、Agent 生成（Skill）、
 * Worker 产出（任务）。三条路径**必须走同一套校验**，否则 Agent 产出的
 * 资产可能绕过类型约束入库。
 *
 * 因此把 `buildAssetData`（按类型校验 metadata）与 `persistAsset`
 * 收敛到这里，API 与 Skill 共用。
 */
import {
  assetSchema,
  deepMerge,
  resolveAssetMetadata,
  ValidationError,
  type AssetType,
} from '@svh/domain';

import { prisma, type Prisma } from './client.js';

/** 规范化后的资产数据（metadata 已按类型校验） */
export interface NormalizedAssetData {
  type: AssetType;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
}

/**
 * 把请求数据归一化为一份合法的资产数据，并**按类型校验 metadata**。
 *
 * 这是资产写入的唯一入口：任何路径都必须经过它，
 * 从而保证 metadata 结构始终合法。
 */
export function buildAssetData(input: {
  type: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): NormalizedAssetData {
  const parsed = assetSchema.safeParse({
    type: input.type,
    name: input.name,
    description: input.description ?? '',
    metadata: input.metadata ?? {},
  });

  if (!parsed.success) {
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
    type: parsed.data.type as AssetType,
    name: parsed.data.name,
    description: parsed.data.description,
    metadata: parsed.data.metadata as Record<string, unknown>,
  };
}

/** 把名称转为可在 `@引用` 中使用的 slug（保留中文） */
export function slugifyAssetName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[\s\u3000]+/gu, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  const truncated = normalized.slice(0, 48).replace(/-+$/g, '');
  if (truncated.length === 0) return `asset-${Date.now().toString(36)}`;
  return truncated;
}

/**
 * 在项目内生成唯一 slug。
 *
 * 冲突时追加 `-2`、`-3`…… 而不是随机串 —— 用户看到 `@苏晚-2`
 * 比 `@苏晚-a3f9` 更容易理解发生了什么。
 */
export async function ensureUniqueSlug(
  projectId: string,
  base: string,
  options: { excludeAssetId?: string } = {},
): Promise<string> {
  const root = base.slice(0, 56);
  let suffix = 0;

  for (;;) {
    const candidate = suffix === 0 ? root : `${root}-${suffix + 1}`;
    const found = await prisma.asset.findUnique({
      where: { projectId_slug: { projectId, slug: candidate } },
      select: { id: true },
    });
    if (found === null || found.id === options.excludeAssetId) return candidate;

    suffix += 1;
    if (suffix > 1000) {
      // 极端情况兜底：避免无限循环
      return `${root.slice(0, 40)}-${Date.now().toString(36)}`;
    }
  }
}

/** 写入资产并记录首版快照 */
export async function persistAsset(input: {
  projectId: string;
  type: string;
  name: string;
  slug?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  files?: unknown[];
  coverUrl?: string | null;
  sourceContentId?: string | null;
  /** 创建该资产的会话 / 消息 / 模型，用于版本溯源 */
  sessionId?: string | null;
  messageId?: string | null;
  modelId?: string | null;
  prompt?: string | null;
  changelog?: string;
}): Promise<{ id: string; slug: string; version: number }> {
  const data = buildAssetData({
    type: input.type,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });

  const slug = await ensureUniqueSlug(input.projectId, input.slug ?? slugifyAssetName(input.name));
  const files = input.files ?? [];

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const asset = await tx.asset.create({
      data: {
        projectId: input.projectId,
        type: data.type,
        name: data.name,
        slug,
        description: data.description,
        metadata: data.metadata as Prisma.InputJsonValue,
        tags: input.tags ?? [],
        files: files as Prisma.InputJsonValue,
        ...(input.coverUrl != null ? { coverUrl: input.coverUrl } : {}),
        ...(input.sourceContentId != null ? { sourceContentId: input.sourceContentId } : {}),
      },
      select: { id: true },
    });

    // 首版即 v1：让版本历史从创建那一刻开始完整
    await tx.assetVersion.create({
      data: {
        assetId: asset.id,
        version: 1,
        snapshot: {
          name: data.name,
          description: data.description,
          metadata: data.metadata,
          tags: input.tags ?? [],
          files,
          coverUrl: input.coverUrl ?? null,
          status: 'active',
        } as Prisma.InputJsonValue,
        changelog: input.changelog ?? '创建资产',
        sessionId: input.sessionId ?? null,
        messageId: input.messageId ?? null,
        modelId: input.modelId ?? null,
        prompt: input.prompt ?? null,
      },
    });

    return { id: asset.id, slug, version: 1 };
  });
}

/**
 * 更新已有资产的 metadata（深合并）并写入新版本。
 *
 * 深合并是 Agent 做局部修改的基础语义：
 * 「把发色改成红色」不能把年龄、脸型等字段抹掉（技术文档第 48 条）。
 */
export async function persistAssetPatch(input: {
  assetId: string;
  patch: {
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    files?: unknown[];
    coverUrl?: string | null;
    status?: 'active' | 'draft' | 'archived';
  };
  changelog?: string;
  sessionId?: string | null;
  messageId?: string | null;
  modelId?: string | null;
  prompt?: string | null;
}): Promise<{ id: string; version: number }> {
  const existing = await prisma.asset.findUnique({ where: { id: input.assetId } });
  if (!existing) {
    throw new ValidationError(`资产 ${input.assetId} 不存在`, {
      userMessage: '没有找到要更新的资产，可能已被删除。',
      context: { assetId: input.assetId },
    });
  }

  const mergedMetadata =
    input.patch.metadata !== undefined
      ? deepMerge(existing.metadata as Record<string, unknown>, input.patch.metadata)
      : (existing.metadata as Record<string, unknown>);

  // 用合并后的完整对象整体校验：判别联合要求 type 与 metadata 同时在场
  const data = buildAssetData({
    type: existing.type,
    name: input.patch.name ?? existing.name,
    description: input.patch.description ?? existing.description,
    metadata: mergedMetadata,
  });

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.asset.update({
      where: { id: input.assetId },
      data: {
        name: data.name,
        description: data.description,
        metadata: data.metadata as Prisma.InputJsonValue,
        ...(input.patch.tags !== undefined ? { tags: input.patch.tags } : {}),
        ...(input.patch.files !== undefined
          ? { files: input.patch.files as Prisma.InputJsonValue }
          : {}),
        ...(input.patch.coverUrl !== undefined ? { coverUrl: input.patch.coverUrl } : {}),
        ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
      },
    });

    const latest = await tx.assetVersion.findFirst({
      where: { assetId: input.assetId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    await tx.assetVersion.create({
      data: {
        assetId: input.assetId,
        version: nextVersion,
        snapshot: {
          name: data.name,
          description: data.description,
          metadata: data.metadata,
          tags: input.patch.tags ?? existing.tags,
          files: input.patch.files ?? (existing.files as unknown[]),
          coverUrl: input.patch.coverUrl ?? existing.coverUrl,
          status: input.patch.status ?? existing.status,
        } as Prisma.InputJsonValue,
        changelog: input.changelog ?? '内容更新',
        sessionId: input.sessionId ?? null,
        messageId: input.messageId ?? null,
        modelId: input.modelId ?? null,
        prompt: input.prompt ?? null,
      },
    });

    return { id: input.assetId, version: nextVersion };
  });
}

/** 登记资产引用（供「修改角色需要同步更新几处」的依赖检查） */
export async function linkAssetReference(input: {
  assetId: string;
  refType: string;
  refId: string;
  refPath?: string | null;
  projectId?: string | null;
  contentId?: string | null;
  notes?: string | null;
}): Promise<void> {
  await prisma.assetReference.upsert({
    where: {
      assetId_refType_refId_refPath: {
        assetId: input.assetId,
        refType: input.refType,
        refId: input.refId,
        refPath: input.refPath ?? '',
      },
    },
    create: {
      assetId: input.assetId,
      refType: input.refType,
      refId: input.refId,
      refPath: input.refPath ?? null,
      projectId: input.projectId ?? null,
      contentId: input.contentId ?? null,
      notes: input.notes ?? null,
    },
    update: {
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
}

/** 按 slug 批量解析资产（Agent 的 @引用 解析） */
export async function resolveAssetsBySlug(
  projectId: string,
  slugs: string[],
): Promise<Array<{ id: string; slug: string; name: string; type: AssetType; metadata: unknown }>> {
  if (slugs.length === 0) return [];
  const found = await prisma.asset.findMany({
    where: { projectId, slug: { in: slugs } },
    select: { id: true, slug: true, name: true, type: true, metadata: true },
  });
  return found.map((a) => ({ ...a, type: a.type as AssetType }));
}

/** 重新导出，便于 API 复用同一入口 */
export { resolveAssetMetadata };
