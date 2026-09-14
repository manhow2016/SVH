/**
 * 分镜仓储
 *
 * ── 为什么 index 的重写都走同一个 helper ──
 * `@@unique([contentId, index])` 让「逐行改 index」在任何顺序下都可能中途撞车：
 * A→1 时 B 还占着 1，B→2 时 C 还占着 2…… 因此统一先把整组 index 平移到
 * 临时区间（+100000），再写目标值。创建、插队插入、删除、重排四条路径共用
 * 一个实现，只有一处需要被测试证明。
 *
 * ── 为什么写完还要读回来校验 ──
 * 唯一约束只能保证「不重复」，保证不了「从 0 连续且无空洞」：漏写一行、写错
 * 一个 id 都不会被数据库拦下。`assertContiguousIndices` 是领域层给出的显式
 * 契约（见 `@svh/domain` 的 storyboard.ts），必须在**写完之后**拿库里的真实
 * 数据调用一次，否则它就只是一句永远成立的自我安慰。
 */
import {
  assertContiguousIndices,
  createShotSchema,
  deepMerge,
  reindex,
  reorderShotsSchema,
  updateShotSchema,
} from '@svh/domain';
import type { CreateShotInput, ReorderShotsInput, UpdateShotInput } from '@svh/domain';

import { prisma, type Prisma } from './client.js';

/**
 * index 重写时用的临时偏移：远大于任何现实镜头数。
 *
 * ── 它有一个必须成立的前置条件 ──
 * 平移后的区间 `[INDEX_OFFSET, INDEX_OFFSET + n - 1]` 必须与目标区间 `[0, n - 1]`
 * 不相交，即 `n ≤ INDEX_OFFSET`。一旦 `n > INDEX_OFFSET`，平移这一步自身就会把某行
 * 写到另一行尚未移走的 index 上，撞 `@@unique([contentId, index])` 并让整笔写入回滚
 * —— 报错信息会指向唯一约束，很难联想到「镜头数超过了偏移量」。
 * 因此下面给出 `assertIndexOffsetSufficient`，在写之前把这种情况变成一句明确的错误。
 */
export const INDEX_OFFSET = 100_000;

/**
 * 校验「平移区间与目标区间不相交」的前置条件（n ≤ INDEX_OFFSET）。
 *
 * 独立成导出函数是为了能被直接断言：真库用例永远造不出十万个镜头，
 * 若把判断埋在事务内部，这条守卫就成了没人验证过的死代码。
 */
export function assertIndexOffsetSufficient(shotCount: number): void {
  if (shotCount > INDEX_OFFSET) {
    throw new Error(
      `镜头数量 ${shotCount} 超过 index 平移区间上限 ${INDEX_OFFSET}：` +
        '平移后的 index 会与目标 index 重叠并撞唯一约束，整笔写入将被回滚',
    );
  }
}

/** 镜头引用资产的 refType 取值（复用既有 asset_references） */
const SHOT_REF_TYPE = 'shot';

/** 仓储对外返回的镜头读模型（字段与 `storyboardShotSchema` 一一对应） */
export interface StoryboardShotRow {
  id: string;
  contentId: string;
  episodeId: string | null;
  index: number;
  durationSeconds: number;
  description: string;
  camera: Record<string, unknown>;
  emotion: string | null;
  dialogue: unknown[];
  imageAssetId: string | null;
  videoAssetId: string | null;
  status: string;
}

interface ShotDbRow {
  id: string;
  contentId: string;
  episodeId: string | null;
  index: number;
  durationSeconds: number;
  description: string;
  camera: unknown;
  emotion: string | null;
  dialogue: unknown;
  imageAssetId: string | null;
  videoAssetId: string | null;
  status: string;
}

/**
 * 把数据库行映射为读模型。
 *
 * ── 为什么逐列取值，而不是 `...row` 展开 ──
 * Prisma 运行时返回的行还带 `createdAt` / `updatedAt`，展开会让「声明的读模型」
 * 与「实际返回值」不一致（TS 的结构化类型看不出这个差异，但 API 序列化、
 * `toEqual` 与 `storyboardShotSchema.parse` 都会看见）。
 *
 * `camera` / `dialogue` 两列在库里是 NOT NULL 且带 `{}` / `[]` 默认值的 Json，
 * 正常读路径下不会是 null —— 这里的兜底只为让「Json 列 → 领域类型」的收窄
 * 在类型层面自洽，不承担业务语义（无需也无法用真库用例覆盖）。
 */
function toRow(row: ShotDbRow): StoryboardShotRow {
  return {
    id: row.id,
    contentId: row.contentId,
    episodeId: row.episodeId,
    index: row.index,
    durationSeconds: row.durationSeconds,
    description: row.description,
    camera: (row.camera ?? {}) as Record<string, unknown>,
    emotion: row.emotion,
    dialogue: Array.isArray(row.dialogue) ? row.dialogue : [],
    imageAssetId: row.imageAssetId,
    videoAssetId: row.videoAssetId,
    status: row.status,
  };
}

export async function listShots(contentId: string): Promise<StoryboardShotRow[]> {
  const rows = await prisma.storyboardShot.findMany({
    where: { contentId },
    orderBy: { index: 'asc' },
  });
  return rows.map(toRow);
}

/**
 * 把整组 index 重写为 0..n-1（两阶段，规避唯一约束），并在写完后读回校验。
 *
 * 阶段一：整组 +INDEX_OFFSET 平移到无人占用的区间（目标值 i+100000 与任何
 * 现有 index 都不相等，因此这一步自身不会撞唯一约束）；
 * 阶段二：逐行写目标 index —— 此时 0..n-1 已全部空出，写哪一行都安全。
 */
async function rewriteIndices(
  tx: Prisma.TransactionClient,
  contentId: string,
  orderedIds: readonly string[],
): Promise<void> {
  // 先确认平移区间够用：n > INDEX_OFFSET 时阶段一自己就会撞唯一约束
  assertIndexOffsetSufficient(orderedIds.length);
  await tx.storyboardShot.updateMany({
    where: { contentId },
    data: { index: { increment: INDEX_OFFSET } },
  });
  for (const { id, index } of reindex(orderedIds)) {
    await tx.storyboardShot.update({ where: { id }, data: { index } });
  }

  const written = await tx.storyboardShot.findMany({
    where: { contentId },
    orderBy: { index: 'asc' },
    select: { id: true, index: true },
  });
  if (written.length !== orderedIds.length) {
    throw new Error(
      `index 重写后镜头数量不一致：期望 ${orderedIds.length} 个，实际 ${written.length} 个（内容 ${contentId}）`,
    );
  }
  assertContiguousIndices(written);
}

export async function createShot(input: CreateShotInput): Promise<StoryboardShotRow> {
  const parsed = createShotSchema.parse(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.storyboardShot.findMany({
      where: { contentId: parsed.contentId },
      orderBy: { index: 'asc' },
      select: { id: true },
    });

    // 新行先落在 index = existing.length：在 0..n-1 的集合里它必然是空位，
    // 因此这一步不会与既有行撞唯一约束，两阶段重排随后统一收拢。
    const created = await tx.storyboardShot.create({
      data: {
        contentId: parsed.contentId,
        index: existing.length,
        durationSeconds: parsed.durationSeconds,
        description: parsed.description,
        camera: parsed.camera as Prisma.InputJsonValue,
        dialogue: parsed.dialogue as Prisma.InputJsonValue,
        ...(parsed.emotion !== undefined ? { emotion: parsed.emotion } : {}),
      },
    });

    const orderedIds = existing.map((shot) => shot.id);
    let insertAt = orderedIds.length;
    if (parsed.afterShotId !== undefined) {
      const anchorIndex = orderedIds.indexOf(parsed.afterShotId);
      if (anchorIndex === -1) {
        // 静默插到队首会让调用方以为「插在某镜头之后」，实际插到了最前面
        throw new Error(
          `插入位置无效：镜头 ${parsed.afterShotId} 不属于内容 ${parsed.contentId}（该内容现有 ${orderedIds.length} 个镜头）`,
        );
      }
      insertAt = anchorIndex + 1;
    }
    orderedIds.splice(insertAt, 0, created.id);

    await rewriteIndices(tx, parsed.contentId, orderedIds);

    const fresh = await tx.storyboardShot.findUniqueOrThrow({ where: { id: created.id } });
    return toRow(fresh);
  });
}

export async function updateShot(id: string, patch: UpdateShotInput): Promise<StoryboardShotRow> {
  const parsed = updateShotSchema.parse(patch);
  const current = await prisma.storyboardShot.findUniqueOrThrow({ where: { id } });

  // Unchecked 变体才直接暴露 imageAssetId / videoAssetId 这些标量外键列；
  // 普通 UpdateInput 只认 imageAsset 关系写法（这里只改 id，不改关系）
  const data: Prisma.StoryboardShotUncheckedUpdateInput = {};
  if (parsed.durationSeconds !== undefined) data.durationSeconds = parsed.durationSeconds;
  if (parsed.description !== undefined) data.description = parsed.description;
  if (parsed.camera !== undefined) {
    // 深合并：与资产 metadata 的局部修改语义一致（null 表示显式清除）。
    // 之所以安全，是因为 updateShotSchema 的 camera 仍是 strict 的 —— 拼错的
    // 键会在 parse 阶段报错，不会经由这里被永久写进 JSON。
    data.camera = deepMerge(
      (current.camera ?? {}) as Record<string, unknown>,
      parsed.camera,
    ) as Prisma.InputJsonValue;
  }
  if (parsed.emotion !== undefined) data.emotion = parsed.emotion;
  if (parsed.dialogue !== undefined) data.dialogue = parsed.dialogue as Prisma.InputJsonValue;
  if (parsed.imageAssetId !== undefined) data.imageAssetId = parsed.imageAssetId;
  if (parsed.videoAssetId !== undefined) data.videoAssetId = parsed.videoAssetId;
  if (parsed.status !== undefined) data.status = parsed.status;

  const updated = await prisma.storyboardShot.update({ where: { id }, data });
  return toRow(updated);
}

export async function deleteShot(id: string): Promise<void> {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const shot = await tx.storyboardShot.findUniqueOrThrow({
      where: { id },
      select: { contentId: true },
    });

    // asset_references 不是外键关联，数据库不会替我们清理，必须显式删
    await tx.assetReference.deleteMany({ where: { refType: SHOT_REF_TYPE, refId: id } });
    // 时间线片段由数据库级联删除（timeline_clips.shotId ON DELETE CASCADE）
    await tx.storyboardShot.delete({ where: { id } });

    const rest = await tx.storyboardShot.findMany({
      where: { contentId: shot.contentId },
      orderBy: { index: 'asc' },
      select: { id: true },
    });
    await rewriteIndices(
      tx,
      shot.contentId,
      rest.map((row) => row.id),
    );
  });
}

export async function reorderShots(input: ReorderShotsInput): Promise<StoryboardShotRow[]> {
  const parsed = reorderShotsSchema.parse(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.storyboardShot.findMany({
      where: { contentId: parsed.contentId },
      select: { id: true },
    });
    const currentIds = new Set(existing.map((row) => row.id));
    const requested = parsed.orderedShotIds;
    const nextIds = new Set(requested);
    // 重复 id 能骗过下面的「集合相等」判断（[a,a,b,b] 与 {a,b} 集合大小相同），
    // 但重排出的 index 必然缺号。挡在写库之前，错误信息也更准确。
    if (nextIds.size !== requested.length) {
      throw new Error(
        `重排失败：请求的 id 列表存在重复（${requested.length} 项，仅 ${nextIds.size} 个不同 id）`,
      );
    }
    // 集合相等（不增不删）是重排的前置条件：少了镜头就会留下 index 空洞，
    // 多了外来 id 则会把别的内容的镜头搬进来
    const sameSize = currentIds.size === nextIds.size;
    const sameMembers = [...currentIds].every((id) => nextIds.has(id));
    if (!sameSize || !sameMembers) {
      throw new Error(
        `重排失败：镜头 id 集合不相等（现有 ${currentIds.size} 个，请求 ${nextIds.size} 个）`,
      );
    }

    await rewriteIndices(tx, parsed.contentId, requested);

    const rows = await tx.storyboardShot.findMany({
      where: { contentId: parsed.contentId },
      orderBy: { index: 'asc' },
    });
    return rows.map(toRow);
  });
}

/**
 * 覆盖式同步镜头的资产引用（演员 / 场景 / 道具）。
 *
 * 复用既有 `asset_references`：它本来就是「谁引用了这个资产」，
 * `@@unique([assetId, refType, refId, refPath])` 保证重复调用幂等。
 * `refPath` 用空串而非 `null`，因为 `null` 在 Postgres 唯一索引里不参与去重。
 */
export async function syncShotAssetRefs(shotId: string, assetIds: readonly string[]): Promise<void> {
  const shot = await prisma.storyboardShot.findUniqueOrThrow({
    where: { id: shotId },
    select: { contentId: true, content: { select: { projectId: true } } },
  });

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.assetReference.deleteMany({
      where: {
        refType: SHOT_REF_TYPE,
        refId: shotId,
        ...(assetIds.length > 0 ? { assetId: { notIn: [...assetIds] } } : {}),
      },
    });
    for (const assetId of assetIds) {
      await tx.assetReference.upsert({
        where: {
          assetId_refType_refId_refPath: {
            assetId,
            refType: SHOT_REF_TYPE,
            refId: shotId,
            refPath: '',
          },
        },
        create: {
          assetId,
          refType: SHOT_REF_TYPE,
          refId: shotId,
          refPath: '',
          projectId: shot.content.projectId,
          contentId: shot.contentId,
        },
        update: {},
      });
    }
  });
}

/** 反查引用了某资产的镜头 id（§37 一致性检查用） */
export async function listShotsReferencingAsset(assetId: string): Promise<string[]> {
  const rows = await prisma.assetReference.findMany({
    where: { assetId, refType: SHOT_REF_TYPE },
    select: { refId: true },
  });
  return rows.map((row) => row.refId);
}
