/**
 * 时间线仓储
 *
 * ── 为什么默认轨道要幂等创建 ──
 * 界面首次进入时间线时应当看到三条空轨，但「首次」是并发不可靠的
 * （两个标签页同时打开就会各建一套）。因此 `ensureDefaultTracks`
 * 以 kind 为判据补齐缺失项，重复调用返回同一批行。
 *
 * ── 为什么写入前要读一次同轨片段 ──
 * 「同轨不重叠」需要看到同轨的其它片段才能判断。检查与写入放在同一事务里，
 * 这是当前唯一的写入路径；将来若有并发写入，需要升级为串行化隔离或
 * 数据库层的排他约束（见设计文档 §9）。
 *
 * ── 为什么写路径也要过 schema（Ruling 10）──
 * 这三条写函数最早是直接吃裸 number 的。`JSON.parse('{"a":1e999}')` 在 JS 里
 * 得到 `Infinity`，而 Fastify 默认就用 `JSON.parse` 解析请求体 —— 一旦接上路由，
 * `startSeconds: 1e999` 会直接写进 float8 列，让时间线总时长与 EDL 全线变成
 * `Infinity`（`Infinity - 1` 仍是 `Infinity`，链路上没有一步会自然报错）。
 * 因此 `createClip` / `updateClip` / `moveClip` 一律**先 parse 再碰数据库**：
 * 校验失败时连事务都不会开，更不会留下半成品。
 *
 * ── 为什么读路径也要 parse，而不是 `as` 断言 ──
 * `as` 只在编译期骗过类型检查，运行时什么都不做：库列被改名、漏写一个字段、
 * Prisma 行多带 `createdAt`/`updatedAt`，它都照单全收并把形状不对的对象当成
 * `Timeline` 交给上层。这里改为逐列映射 + 逐条 `timelineClipSchema.parse`，
 * 由读模型自己决定什么算合法数据。
 */
import {
  assertNoOverlap,
  createClipSchema,
  moveClipSchema,
  timelineClipSchema,
  timelineDurationSeconds,
  timelineSchema,
  updateClipSchema,
} from '@svh/domain';
import type {
  CreateClipInput,
  MoveClipInput,
  Timeline,
  TimelineClip,
  TimelineTrack,
  TimelineTrackKind,
  UpdateClipInput,
} from '@svh/domain';

import { prisma, type Prisma } from './client.js';

/** 轨道读模型（`ensureDefaultTracks` 的返回）：不含片段，片段由 `getTimeline` 组装 */
export interface TimelineTrackRow {
  id: string;
  contentId: string;
  kind: TimelineTrackKind;
  label: string;
  order: number;
}

/** 片段读模型：与领域读模型同形（同一条 schema 解析出来的） */
export type TimelineClipRow = TimelineClip;

/** 轨道行在库里的原始形状（只列用得到的列，避免依赖 Prisma 的全部字段） */
interface TrackDbRow {
  id: string;
  contentId: string;
  kind: TimelineTrackKind;
  label: string;
  order: number;
}

/** 片段行在库里的原始形状（无 `createdAt`/`updatedAt`：读模型不含这两列） */
interface ClipDbRow {
  id: string;
  trackId: string;
  shotId: string | null;
  assetId: string | null;
  startSeconds: number;
  durationSeconds: number;
}

/** 默认三条轨：与设计文档 §6.2 的标签一致（order 即数组下标） */
const DEFAULT_TRACKS: readonly { kind: TimelineTrackKind; label: string }[] = [
  { kind: 'video', label: '画面' },
  { kind: 'audio', label: '声音' },
  { kind: 'subtitle', label: '字幕' },
];

/**
 * 逐列映射 + 逐条 parse。
 *
 * 不写 `{ ...row }`：Prisma 行还带 `createdAt` / `updatedAt`，展开会把它们
 * 漏进返回值（`timelineClipSchema` 是 strict 的，多一列会直接抛错 —— 这正是
 * 我们想要的：读模型的形状由 schema 说了算，不由 Prisma 说了算）。
 */
function toClipRow(row: ClipDbRow): TimelineClipRow {
  return timelineClipSchema.parse({
    id: row.id,
    trackId: row.trackId,
    shotId: row.shotId,
    assetId: row.assetId,
    startSeconds: row.startSeconds,
    durationSeconds: row.durationSeconds,
  });
}

/** 轨道行同样逐列映射：返回形状只由这里的六个字面量决定 */
function toTrackRow(row: TrackDbRow): TimelineTrackRow {
  return {
    id: row.id,
    contentId: row.contentId,
    kind: row.kind,
    label: row.label,
    order: row.order,
  };
}

/**
 * 幂等补齐默认轨道。
 *
 * `order` 取「当前空闲的最小序号」，而不是固定下标、也不是单纯的 `existing.length`：
 * 同一内容允许多条同 kind 的轨道（如 BGM 与旁白两条 audio），已存在的轨道未必是
 * 默认那三条，order 也未必连续（脚本或后续功能都可能直接建轨）。此时
 * `existing.length` 可能正好落在某个已占用的 order 上，撞 `@@unique([contentId, order])`
 * —— 报错会指向唯一约束，很难联想到是「补默认轨」这一步算错了序号。
 */
export async function ensureDefaultTracks(contentId: string): Promise<TimelineTrackRow[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.timelineTrack.findMany({
      where: { contentId },
      orderBy: { order: 'asc' },
    });
    const kinds = new Set(existing.map((track) => track.kind));
    const usedOrders = new Set(existing.map((track) => track.order));
    let nextOrder = existing.length;

    /** 取下一个空闲序号（跳过已占用的 order），取到即标记为已占用 */
    const takeFreeOrder = (): number => {
      while (usedOrders.has(nextOrder)) nextOrder += 1;
      usedOrders.add(nextOrder);
      return nextOrder;
    };

    for (const preset of DEFAULT_TRACKS) {
      if (kinds.has(preset.kind)) continue;
      await tx.timelineTrack.create({
        data: { contentId, kind: preset.kind, label: preset.label, order: takeFreeOrder() },
      });
    }

    const tracks = await tx.timelineTrack.findMany({
      where: { contentId },
      orderBy: { order: 'asc' },
    });
    return tracks.map(toTrackRow);
  });
}

/** 读整条时间线：轨道按 order、片段按起点排序，总时长由领域函数算出 */
export async function getTimeline(contentId: string): Promise<Timeline> {
  const rows = await prisma.timelineTrack.findMany({
    where: { contentId },
    orderBy: { order: 'asc' },
    include: { clips: { orderBy: { startSeconds: 'asc' } } },
  });

  // 注意这里没有 `as TimelineTrack[]` / `as TimelineClip[]`：
  // 每个片段都过一遍读模型 schema，字段缺失、来源不唯一、越界数值都会当场抛错。
  const tracks: TimelineTrack[] = rows.map((track) => ({
    id: track.id,
    contentId: track.contentId,
    kind: track.kind,
    label: track.label,
    order: track.order,
    clips: track.clips.map(toClipRow),
  }));

  // 整棵树再过一次总 schema：`durationSeconds` 这类派生字段也要满足契约
  return timelineSchema.parse({
    contentId,
    tracks,
    durationSeconds: timelineDurationSeconds(tracks),
  });
}

/**
 * 同轨不重叠守卫：把候选片段与同轨其它片段一起交给领域校验。
 *
 * 领域函数只认得「起点 + 时长」，报错里不会出现轨道 —— 而调用方最需要的
 * 恰恰是「哪条轨、哪个时间段放不下」。这里补上这层上下文，并把原始错误挂在
 * `cause` 上，不吞掉细节。
 */
async function assertTrackFree(
  tx: Prisma.TransactionClient,
  trackId: string,
  candidate: { id?: string; startSeconds: number; durationSeconds: number },
): Promise<void> {
  const others = await tx.timelineClip.findMany({
    where: { trackId, ...(candidate.id !== undefined ? { id: { not: candidate.id } } : {}) },
    select: { startSeconds: true, durationSeconds: true },
  });
  try {
    assertNoOverlap([
      ...others,
      { startSeconds: candidate.startSeconds, durationSeconds: candidate.durationSeconds },
    ]);
  } catch (error) {
    const endSeconds = candidate.startSeconds + candidate.durationSeconds;
    throw new Error(
      `同轨片段重叠：轨道 ${trackId} 上放不下 [${candidate.startSeconds}, ${endSeconds}) 秒的片段` +
        `（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
}

export async function createClip(input: CreateClipInput): Promise<TimelineClipRow> {
  // 先 parse 再开事务：非法入参不该在库里留下任何痕迹（连事务都不必开）
  const parsed = createClipSchema.parse(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await assertTrackFree(tx, parsed.trackId, {
      startSeconds: parsed.startSeconds,
      durationSeconds: parsed.durationSeconds,
    });

    const created = await tx.timelineClip.create({
      data: {
        trackId: parsed.trackId,
        shotId: parsed.shotId ?? null,
        assetId: parsed.assetId ?? null,
        startSeconds: parsed.startSeconds,
        durationSeconds: parsed.durationSeconds,
      },
    });
    return toClipRow(created);
  });
}

export async function updateClip(id: string, patch: UpdateClipInput): Promise<TimelineClipRow> {
  const parsed = updateClipSchema.parse(patch);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const current = await tx.timelineClip.findUniqueOrThrow({ where: { id } });
    // 未传的字段保持原值：patch 语义，不是整行覆盖
    const startSeconds = parsed.startSeconds ?? current.startSeconds;
    const durationSeconds = parsed.durationSeconds ?? current.durationSeconds;

    await assertTrackFree(tx, current.trackId, { id, startSeconds, durationSeconds });

    const updated = await tx.timelineClip.update({
      where: { id },
      data: { startSeconds, durationSeconds },
    });
    return toClipRow(updated);
  });
}

export async function moveClip(id: string, target: MoveClipInput): Promise<TimelineClipRow> {
  const parsed = moveClipSchema.parse(target);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const current = await tx.timelineClip.findUniqueOrThrow({ where: { id } });
    const trackId = parsed.trackId ?? current.trackId;
    const startSeconds = parsed.startSeconds ?? current.startSeconds;

    // 校验落在**目标轨**上：换轨时来源轨空不空与本次写入无关
    await assertTrackFree(tx, trackId, {
      id,
      startSeconds,
      durationSeconds: current.durationSeconds,
    });

    const updated = await tx.timelineClip.update({
      where: { id },
      data: { trackId, startSeconds },
    });
    return toClipRow(updated);
  });
}

export async function deleteClip(id: string): Promise<void> {
  await prisma.timelineClip.delete({ where: { id } });
}
