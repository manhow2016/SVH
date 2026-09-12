/**
 * Worker 的 Skill 依赖装配
 *
 * 把 `@svh/skills` 定义的端口（SkillDeps）用真实实现填满。
 * 这是**唯一**把数据库、模型层与技能实现绑在一起的地方 ——
 * 技能实现本身只依赖接口，因此可以脱离数据库做单测。
 */
import {
  linkAssetReference,
  persistAsset,
  persistAssetPatch,
  prisma,
  resolveAssetsBySlug,
  type Prisma,
} from '@svh/database';
import type {
  SkillAssetPort,
  SkillContentPort,
  SkillDeps,
  SkillModelPort,
  SkillModelRecordPort,
  SkillProjectPort,
  SkillProjectWritePort,
} from '@svh/skills';
import type { ModelDescriptor, ModelRouter } from '@svh/model';

/** 资产端口实现 */
function createAssetPort(): SkillAssetPort {
  return {
    create: async (input) =>
      persistAsset({
        projectId: input.projectId,
        type: input.type,
        name: input.name,
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.files !== undefined ? { files: input.files } : {}),
        ...(input.coverUrl !== undefined ? { coverUrl: input.coverUrl } : {}),
        ...(input.sourceContentId !== undefined ? { sourceContentId: input.sourceContentId } : {}),
        ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
      }),

    update: async (input) =>
      persistAssetPatch({
        assetId: input.assetId,
        patch: input.patch,
        ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
      }),

    findBySlug: async (projectId, slug) => {
      const found = await prisma.asset.findUnique({
        where: { projectId_slug: { projectId, slug } },
        select: { id: true, slug: true, name: true, type: true, metadata: true },
      });
      return found;
    },

    listByProject: async (projectId, filter) => {
      const found = await prisma.asset.findMany({
        where: {
          projectId,
          status: { not: 'archived' },
          ...(filter?.type !== undefined ? { type: filter.type as never } : {}),
        },
        select: { id: true, slug: true, name: true, type: true, metadata: true },
        take: filter?.limit ?? 100,
        orderBy: { updatedAt: 'desc' },
      });
      return found;
    },
  };
}

/** 内容端口实现 */
function createContentPort(): SkillContentPort {
  return {
    get: async (contentId) => {
      const row = await prisma.content.findUnique({
        where: { id: contentId },
        select: {
          id: true,
          projectId: true,
          type: true,
          title: true,
          brief: true,
          metadata: true,
          status: true,
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.projectId,
        type: row.type,
        title: row.title,
        brief: row.brief,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        status: row.status,
      };
    },

    update: async (input) => {
      const existing = await prisma.content.findUnique({
        where: { id: input.contentId },
        select: { metadata: true, title: true, brief: true, status: true },
      });
      if (!existing) return;

      // metadata 深合并：Skill 只更新自己负责的字段，不抹掉其它字段
      const mergedMetadata =
        input.patch.metadata !== undefined
          ? {
              ...((existing.metadata ?? {}) as Record<string, unknown>),
              ...input.patch.metadata,
            }
          : undefined;

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updated = await tx.content.update({
          where: { id: input.contentId },
          data: {
            ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
            ...(input.patch.brief !== undefined ? { brief: input.patch.brief } : {}),
            ...(mergedMetadata !== undefined
              ? { metadata: mergedMetadata as Prisma.InputJsonValue }
              : {}),
            ...(input.patch.status !== undefined ? { status: input.patch.status as never } : {}),
          },
          select: { title: true, brief: true, metadata: true, status: true },
        });

        // 内容也必须有版本（技术文档第 49 条）
        const latest = await tx.contentVersion.findFirst({
          where: { contentId: input.contentId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });

        await tx.contentVersion.create({
          data: {
            contentId: input.contentId,
            version: (latest?.version ?? 0) + 1,
            snapshot: {
              title: updated.title,
              brief: updated.brief,
              metadata: (updated.metadata ?? {}) as Record<string, unknown>,
              status: updated.status,
            } as Prisma.InputJsonValue,
            changelog: input.changelog ?? '内容更新',
          },
        });
      });
    },

    addOutput: async (input) => {
      const created = await prisma.output.create({
        data: {
          projectId: input.projectId,
          ...(input.contentId.length > 0 ? { contentId: input.contentId } : {}),
          name: input.name,
          type: input.type,
          ...(input.assetId != null ? { assetId: input.assetId } : {}),
          ...(input.storage != null ? { storage: input.storage as Prisma.InputJsonValue } : {}),
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { outputId: created.id };
    },
  };
}

/** 项目记忆端口实现 */
function createProjectPort(): SkillProjectPort & SkillProjectWritePort {
  return {
    getMemory: async (projectId) => {
      const row = await prisma.project.findUnique({
        where: { id: projectId },
        select: { memory: true },
      });
      return (row?.memory ?? {}) as Record<string, unknown>;
    },

    /**
     * 合并项目记忆。
     *
     * 只做浅合并：深层结构（goals / brand / visual / production / preferences）
     * 由各自负责的片段整体替换，避免 Skill 无意间把子字段搅乱。
     */
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
  };
}

/** 模型端口实现：包装 Model Router */
function createModelPort(router: ModelRouter, models: ModelDescriptor[]): SkillModelPort {
  return {
    // 透传 context：让 model_tasks 记录到具体任务，支撑成本归因
    invoke: (request, context) => router.invoke(request, context ?? {}),
    listModels: () => models,
  };
}

/** 模型调用记录端口（Model Router 内部已通过 recordCall 落库，此处留作扩展） */
function createModelRecordPort(): SkillModelRecordPort {
  return {
    record: async () => {
      // Model Router 通过 ModelCallRecorder 统一落库，避免同一事实两处写入。
      // 保留该端口是为了将来支持「Skill 想单独记录一次内部调用」的场景。
    },
  };
}

/** 装配 SkillDeps */
export function buildSkillDeps(input: {
  router: ModelRouter;
  models: ModelDescriptor[];
}): SkillDeps {
  return {
    models: createModelPort(input.router, input.models),
    assets: createAssetPort(),
    contents: createContentPort(),
    projects: createProjectPort(),
    modelRecords: createModelRecordPort(),
  };
}

/** 供其它模块复用：登记资产引用 */
export { linkAssetReference, resolveAssetsBySlug };
