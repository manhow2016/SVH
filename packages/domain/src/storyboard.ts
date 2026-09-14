/**
 * 分镜（Storyboard Shot）领域契约
 *
 * ── 为什么机位不做成枚举 ──
 * 规范 §25 只约定 `camera` 的三个自由字符串。词表（景别/角度/运镜的受控值）
 * 属于界面建议值，先由 UI 侧给候选，不在领域层替产品拍板 —— 一旦写成枚举，
 * 将来每加一个运镜方式都要一次迁移 + 一次漂移测试改动。
 *
 * ── 为什么 index 的连续性由领域函数守 ──
 * 数据库只能保证「同一内容内不重复」，保证不了「从 0 连续且无空洞」。
 * 而时间线、Storyboard UI、AI 的「第 3 个镜头」都默认它是连续的，
 * 所以这里给出显式校验，由仓储在每次写完后调用。
 */
import { z } from 'zod';

import { durationSecondsSchema, idSchema, slugSchema } from './common.js';
import { SHOT_STATUSES } from './enums.js';

export const shotStatusSchema = z.enum(SHOT_STATUSES);

/** 机位：三个字段全可选；`.strict()` 让拼错的键在写入前就报错 */
export const cameraSchema = z
  .object({
    shotType: z.string().max(32).optional(),
    angle: z.string().max(32).optional(),
    movement: z.string().max(32).optional(),
  })
  .strict();

/** 一句台词：可绑定角色资产 slug（与 `@引用` 同一套 slug 约定） */
export const dialogueSchema = z
  .object({
    characterSlug: slugSchema.optional(),
    text: z.string().min(1).max(500),
  })
  .strict();

/** 读模型：数据库行的**子集**（不含 `createdAt` / `updatedAt`，逐列映射后解析） */
export const storyboardShotSchema = z.object({
  id: idSchema,
  contentId: idSchema,
  episodeId: idSchema.nullable(),
  index: z.number().int().nonnegative(),
  durationSeconds: durationSecondsSchema,
  description: z.string().max(2000),
  camera: cameraSchema,
  emotion: z.string().max(64).nullable(),
  dialogue: z.array(dialogueSchema).max(50),
  imageAssetId: idSchema.nullable(),
  videoAssetId: idSchema.nullable(),
  status: shotStatusSchema,
});

export type StoryboardShot = z.infer<typeof storyboardShotSchema>;

export const createShotSchema = z
  .object({
    contentId: idSchema,
    durationSeconds: durationSecondsSchema,
    description: z.string().max(2000).default(''),
    camera: cameraSchema.default({}),
    emotion: z.string().max(64).optional(),
    dialogue: z.array(dialogueSchema).max(50).default([]),
    /** 插到该镜头之后；不传则追加到末尾 */
    afterShotId: idSchema.optional(),
  })
  .strict();

export type CreateShotInput = z.input<typeof createShotSchema>;

/**
 * 更新镜头：部分更新，但**至少要给一个字段**。
 *
 * 空 patch 会白写一次库（`update(...)` 带着空 data 跑一趟）却什么都没改，
 * 调用方还容易把它当成「已保存」。同一片的 `updateClipSchema` / `moveClipSchema`
 * 都带这条 refine，这里与之对齐。
 */
export const updateShotSchema = z
  .object({
    durationSeconds: durationSecondsSchema.optional(),
    description: z.string().max(2000).optional(),
    /** 深合并（复用 asset.ts 的 deepMerge）：只改运镜不该抹掉景别 */
    camera: cameraSchema.partial().optional(),
    emotion: z.string().max(64).nullable().optional(),
    dialogue: z.array(dialogueSchema).max(50).optional(),
    imageAssetId: idSchema.nullable().optional(),
    videoAssetId: idSchema.nullable().optional(),
    status: shotStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: '更新镜头至少需要一个字段',
  });

export type UpdateShotInput = z.infer<typeof updateShotSchema>;

export const reorderShotsSchema = z
  .object({
    contentId: idSchema,
    /**
     * 完整有序列表。schema 只保证**非空**：「与现有镜头集合完全相等（不增不删）」
     * 需要读库才能判断，因此集合比对在仓储层 `reorderShots` 里做（不相等抛错），
     * 这里不承诺 schema 无法兑现的事。
     */
    orderedShotIds: z.array(idSchema).min(1),
  })
  .strict();

export type ReorderShotsInput = z.infer<typeof reorderShotsSchema>;

/**
 * 校验 index 恰好是 0..n-1（顺序无关）。
 *
 * 失败时给出「期望值 + 实际值 + 镜头 id」，便于从日志直接定位是哪一行。
 */
export function assertContiguousIndices(shots: readonly { id: string; index: number }[]): void {
  const sorted = [...shots].sort((a, b) => a.index - b.index);
  let expected = 0;
  for (const shot of sorted) {
    if (shot.index !== expected) {
      throw new Error(
        `镜头 index 不连续：期望 ${expected}，实际 ${shot.index}（镜头 ${shot.id}）`,
      );
    }
    expected += 1;
  }
}

/** 由有序 id 列表生成目标 index 映射 */
export function reindex(orderedShotIds: readonly string[]): { id: string; index: number }[] {
  return orderedShotIds.map((id, index) => ({ id, index }));
}
