/**
 * 资产版本仓储
 *
 * 技术文档第 49 条要求：**所有生成内容必须支持版本**，
 * 用户可以对 Shot 03 执行「恢复 v1」。
 *
 * 设计取舍：每次变更都写入一条**完整快照**（而非增量 diff）。
 * 原因：
 * - 资产 metadata 结构随类型差异极大，增量 diff 难以正确表达「字段被删除」
 * - 用户需要的是「一键恢复到那一刻」，快照能直接还原，无需重放
 * - 资产条目数量级远小于事件流，存储成本可接受
 */
import { assetSnapshotSchema, type AssetSnapshot } from '@svh/domain';

import { prisma, type Prisma } from './client.js';

/** 版本写入所需的额外上下文 */
export interface VersionContext {
  /** 变更说明，如「服装颜色 → 中国红」 */
  changelog?: string;
  /** 产生该版本的会话与消息，用于回溯「哪句话导致的改动」 */
  sessionId?: string | null;
  messageId?: string | null;
  /** 该版本所用的模型与提示词快照，便于复现 */
  modelId?: string | null;
  prompt?: string | null;
  createdBy?: string | null;
}

/** 把数据库资产行转为快照结构 */
export function toSnapshot(asset: {
  name: string;
  description: string;
  metadata: unknown;
  tags: string[];
  files: unknown;
  coverUrl: string | null;
  status: string;
}): AssetSnapshot {
  return assetSnapshotSchema.parse({
    name: asset.name,
    description: asset.description,
    metadata: (asset.metadata ?? {}) as Record<string, unknown>,
    tags: asset.tags,
    files: Array.isArray(asset.files) ? asset.files : [],
    coverUrl: asset.coverUrl,
    status: asset.status,
  });
}

/**
 * 为资产创建一个新版本。
 *
 * **必须在与资产写入相同的事务中调用**，否则会出现
 * 「资产改了但版本没记」或反之的不一致。
 *
 * @returns 新版本号
 */
export async function createAssetVersion(
  assetId: string,
  context: VersionContext = {},
): Promise<number> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    throw new Error(`创建资产版本失败：资产 ${assetId} 不存在`);
  }

  // 取当前最大版本号 +1。并发写入由 @@unique([assetId, version]) 兜底，
  // 冲突时上层事务会回滚重试。
  const latest = await prisma.assetVersion.findFirst({
    where: { assetId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  await prisma.assetVersion.create({
    data: {
      assetId,
      version: nextVersion,
      snapshot: toSnapshot(asset) as never,
      changelog: context.changelog ?? '',
      sessionId: context.sessionId ?? null,
      messageId: context.messageId ?? null,
      modelId: context.modelId ?? null,
      prompt: context.prompt ?? null,
      createdBy: context.createdBy ?? null,
    },
  });

  return nextVersion;
}

/** 列出资产的版本历史（不含快照体，列表页无需传输大对象） */
export async function listAssetVersions(assetId: string) {
  return prisma.assetVersion.findMany({
    where: { assetId },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      changelog: true,
      modelId: true,
      createdBy: true,
      createdAt: true,
      sessionId: true,
      messageId: true,
    },
  });
}

/** 读取某个版本（含快照，用于对比与恢复） */
export async function getAssetVersion(assetId: string, version: number) {
  return prisma.assetVersion.findUnique({
    where: { assetId_version: { assetId, version } },
  });
}

/**
 * 恢复到指定版本。
 *
 * 语义说明：恢复**不是回滚历史**，而是把该版本的内容作为**新版本**写入
 * （形成 v4 = v1 的内容）。这样历史保持只增不改，用户即使恢复错了
 * 也能再恢复回去。
 *
 * @returns 恢复后产生的新版本号
 */
export async function restoreAssetVersion(
  assetId: string,
  version: number,
  context: VersionContext = {},
): Promise<number> {
  const target = await getAssetVersion(assetId, version);
  if (!target) {
    throw new Error(`资产 ${assetId} 不存在版本 v${version}`);
  }

  const snapshot = assetSnapshotSchema.parse(target.snapshot);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.asset.update({
      where: { id: assetId },
      data: {
        name: snapshot.name,
        description: snapshot.description,
        metadata: snapshot.metadata as never,
        tags: snapshot.tags,
        files: snapshot.files as never,
        coverUrl: snapshot.coverUrl ?? null,
        status: snapshot.status as never,
      },
    });

    const latest = await tx.assetVersion.findFirst({
      where: { assetId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    await tx.assetVersion.create({
      data: {
        assetId,
        version: nextVersion,
        snapshot: snapshot as never,
        changelog: context.changelog ?? `恢复到 v${version}`,
        sessionId: context.sessionId ?? null,
        messageId: context.messageId ?? null,
        createdBy: context.createdBy ?? null,
      },
    });

    return nextVersion;
  });
}

/**
 * 查询引用某资产的记录。
 *
 * 用于实现技术文档第 48 / 91 条：
 * 用户说「女主换成黑色长发」，Agent 需要回答
 * 「有 12 个镜头引用了该角色，是否同步更新？」。
 */
export async function findAssetReferences(assetId: string) {
  return prisma.assetReference.findMany({
    where: { assetId },
    orderBy: { createdAt: 'asc' },
  });
}

/** 统计资产被引用的次数 */
export async function countAssetReferences(assetId: string): Promise<number> {
  return prisma.assetReference.count({ where: { assetId } });
}
