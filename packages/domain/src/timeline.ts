/**
 * 时间线（Timeline）领域契约
 *
 * ── 为什么「恰好一个来源」要写两遍 ──
 * domain 的判别联合让**调用方**在编译期就写不出双来源；数据库的 CHECK
 * 挡住绕过仓储的直接写入（脚本、迁移、将来的批量导入）。两层缺一不可：
 * 只有 domain 时，一条 `$executeRaw` 就能写脏数据；只有 DB 时，
 * 错误要等到写库才暴露、且报错信息对调用方没有指导意义。
 *
 * ── 为什么重叠校验不放进数据库 ──
 * Postgres 需要 `EXCLUDE USING gist` + btree_gist 扩展才能表达，成本与
 * 运维面都超出本轮收益；而写入路径目前只有这一个仓储函数。
 */
import { z } from 'zod';

import { durationSecondsSchema, idSchema } from './common.js';
import { TIMELINE_TRACK_KINDS } from './enums.js';

export const timelineTrackKindSchema = z.enum(TIMELINE_TRACK_KINDS);

/** 写入用的来源：判别联合，编译期即排除双来源 */
export const timelineClipSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('shot'), shotId: idSchema }).strict(),
  z.object({ source: z.literal('asset'), assetId: idSchema }).strict(),
]);

/**
 * 「恰好一个来源」的共享谓词。
 *
 * 这条规则一共编码在三处，改任何一处都必须同步，否则会出现「写进去的合法、
 * 读出来非法」这类漂移：
 * 1. `timelineClipSourceSchema` 的判别联合（带 `source` 判别键的 API 入参，编译期排除双来源）；
 * 2. 读模型 `timelineClipSchema`（数据库行，`null` 表示没有来源）；
 * 3. 写模型 `createClipSchema`（仓储入参，`undefined` 表示没有给来源）。
 * 后两处共用这个谓词，把「两处手写条件」收敛成一处；`null` 与 `undefined`
 * 都算「没有来源」，因此读模型与写模型可以共用同一个判据。
 */
function hasExactlyOneSource(value: { shotId?: string | null; assetId?: string | null }): boolean {
  const hasShot = value.shotId !== undefined && value.shotId !== null;
  const hasAsset = value.assetId !== undefined && value.assetId !== null;
  return hasShot !== hasAsset;
}

/** 毫秒级浮点容差：0.1 + 0.2 这类误差不该被判成重叠 */
const OVERLAP_EPSILON = 1e-6;

/** 读模型的起点：非负且**有限**（理由同写路径的 `.finite()`，见下方写路径注释） */
const readStartSecondsSchema = z.number().nonnegative().finite();

/** 读模型的时长：非负且**有限** */
const readDurationSecondsSchema = z.number().nonnegative().finite();

/** 读模型：与数据库行一一对应 */
export const timelineClipSchema = z
  .object({
    id: idSchema,
    trackId: idSchema,
    shotId: idSchema.nullable(),
    assetId: idSchema.nullable(),
    startSeconds: readStartSecondsSchema,
    // 片段时长复用写路径的 durationSecondsSchema：它的 `.max(8h)` 同样拦得住 Infinity
    durationSeconds: durationSecondsSchema,
  })
  .strict()
  .refine(hasExactlyOneSource, {
    message: '片段必须且只能有一个来源（shotId 或 assetId）',
  });

export type TimelineClip = z.infer<typeof timelineClipSchema>;

export const timelineTrackSchema = z
  .object({
    id: idSchema,
    contentId: idSchema,
    kind: timelineTrackKindSchema,
    label: z.string().max(64),
    order: z.number().int().nonnegative(),
    clips: z.array(timelineClipSchema),
  })
  .strict();

export type TimelineTrack = z.infer<typeof timelineTrackSchema>;

export const timelineSchema = z
  .object({
    contentId: idSchema,
    durationSeconds: readDurationSecondsSchema,
    tracks: z.array(timelineTrackSchema),
  })
  .strict();

export type Timeline = z.infer<typeof timelineSchema>;

/* ────────────────────────── 写路径契约 ────────────────────────── */

/**
 * 写路径的起点：非负且必须**有限**。
 *
 * ── 为什么 `.nonnegative()` 之后还要 `.finite()` ──
 * Fastify 默认用 `JSON.parse` 解析请求体，而 `JSON.parse('{"startSeconds":1e999}')`
 * 不报错 —— 它得到的是 `Infinity`。zod 的 `nonnegative()` 对 `Infinity` 判真
 * （`Infinity >= 0`，实测放行），于是它会一路写进 `timeline_clips.startSeconds`
 * 这个 float8 列：时间线总时长、重叠比较、EDL 全长全部变成 `Infinity`，
 * 而 `Infinity - 1` 仍是 `Infinity`，链路上没有任何一步会自然报错。
 * 只有 `.finite()` 能在写库之前挡住它。
 */
const clipStartSecondsSchema = z.number().nonnegative().finite();

/**
 * 创建片段：轨道 + **恰好一个**来源 + 起点 + 时长。
 *
 * 来源用 `refine` 而不是 `timelineClipSourceSchema` 那个判别联合：后者是
 * 「带 `source` 判别键的 API 入参」形状，而这里要与数据库列同形（`shotId` /
 * `assetId` 二者其一），这样才能直接交给 Prisma。判据与读模型共用
 * `hasExactlyOneSource`，避免两处手写条件各自漂移（三处编码见该函数注释）。
 * 双来源与无来源都必须在写库前被拒（数据库那条 CHECK 只是最后一道兜底）。
 */
export const createClipSchema = z
  .object({
    trackId: idSchema,
    shotId: idSchema.optional(),
    assetId: idSchema.optional(),
    startSeconds: clipStartSecondsSchema,
    durationSeconds: durationSecondsSchema,
  })
  .strict()
  .refine(hasExactlyOneSource, {
    message: '片段必须且只能有一个来源（shotId 或 assetId）',
  });

export type CreateClipInput = z.input<typeof createClipSchema>;

/** 更新片段：只改起点与时长（换轨走 `moveClipSchema`），但至少要给一个字段 */
export const updateClipSchema = z
  .object({
    startSeconds: clipStartSecondsSchema.optional(),
    durationSeconds: durationSecondsSchema.optional(),
  })
  .strict()
  .refine((value) => value.startSeconds !== undefined || value.durationSeconds !== undefined, {
    message: '更新片段至少需要一个字段（startSeconds 或 durationSeconds）',
  });

export type UpdateClipInput = z.input<typeof updateClipSchema>;

/** 移动片段：换轨与改起点可任意组合，但不能什么都不给 */
export const moveClipSchema = z
  .object({
    trackId: idSchema.optional(),
    startSeconds: clipStartSecondsSchema.optional(),
  })
  .strict()
  .refine((value) => value.trackId !== undefined || value.startSeconds !== undefined, {
    message: '移动片段至少需要一个字段（trackId 或 startSeconds）',
  });

export type MoveClipInput = z.input<typeof moveClipSchema>;

interface SpanLike {
  startSeconds: number;
  durationSeconds: number;
}

/**
 * 同一轨道内不允许片段重叠。
 *
 * 实现刻意不按下标访问数组（`noUncheckedIndexedAccess` 下下标访问要处理
 * `undefined`），改为一次线性扫描：按起点排序后，只要每个片段的起点不小于
 * 前一个的终点即可。
 */
export function assertNoOverlap(clips: readonly SpanLike[]): void {
  const sorted = [...clips].sort((a, b) => a.startSeconds - b.startSeconds);
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const clip of sorted) {
    if (clip.startSeconds < previousEnd - OVERLAP_EPSILON) {
      throw new Error(
        `同轨片段重叠：起点 ${clip.startSeconds} 早于上一段的终点 ${previousEnd}`,
      );
    }
    previousEnd = clip.startSeconds + clip.durationSeconds;
  }
}

/**
 * 时间线总时长 = 所有轨道片段的最右端。
 *
 * 取整到毫秒，与 EDL（`edit.video` 的产出）保持一致的单位与精度。
 */
export function timelineDurationSeconds(
  tracks: readonly { clips: readonly SpanLike[] }[],
): number {
  let max = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.startSeconds + clip.durationSeconds);
    }
  }
  return Math.round(max * 1000) / 1000;
}
