/**
 * Timeline 领域校验（V0.3 文档 §五：Timeline Clip 规则）。
 *
 * 校验分两层：
 * - 字段级校验（本文件纯函数）：startTime/duration/name/坐标/元数据等；
 * - 上下文校验（validateClipAgainstContext）：规则 3/4/6/7/8 需要
 *   timeline/track/asset/shot 的已知信息，由 Service（Phase 3）加载后调用，
 *   领域层只做纯函数断言，不做 I/O。
 */
import type { AssetType } from "../asset/asset-types";
import { validationError } from "../errors";
import type {
  TimelineClip,
  TimelineStatus,
  TimelineTrackType,
} from "./timeline-types";

export const TIMELINE_STATUSES: readonly TimelineStatus[] = [
  "draft",
  "editing",
  "ready",
  "rendering",
  "completed",
  "failed",
];

export const TIMELINE_TRACK_TYPES: readonly TimelineTrackType[] = [
  "video",
  "audio",
  "subtitle",
  "overlay",
];

/** 渲染目标默认值（短剧常见规格；Service 创建时采用，可被输入覆盖） */
export const DEFAULT_TIMELINE_FPS = 24;
export const DEFAULT_TIMELINE_WIDTH = 1920;
export const DEFAULT_TIMELINE_HEIGHT = 1080;

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_DURATION = 24 * 60 * 60; // 单剪辑/单时间轴上限：24 小时，防异常大值
const MAX_DIMENSION = 8192; // 8K 上限
const MAX_FPS = 240;

export function isTimelineStatus(v: unknown): v is TimelineStatus {
  return typeof v === "string" && (TIMELINE_STATUSES as readonly string[]).includes(v);
}

export function isTimelineTrackType(v: unknown): v is TimelineTrackType {
  return typeof v === "string" && (TIMELINE_TRACK_TYPES as readonly string[]).includes(v);
}

/** 校验并规范时间轴名称（非空，<= 200） */
export function validateTimelineName(name: unknown): string {
  if (typeof name !== "string") {
    throw validationError("时间轴名称必须为字符串");
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw validationError("时间轴名称不能为空");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw validationError(`时间轴名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 规范可选描述（空串转 undefined；截断到 2000） */
export function validateTimelineDescription(description: unknown): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== "string") {
    throw validationError("时间轴描述必须为字符串");
  }
  const trimmed = description.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_DESCRIPTION_LENGTH);
}

/** 校验时长（规则 2：duration > 0；上限防异常） */
export function validateTimelineDuration(duration: unknown): number {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw validationError("时长必须为正数（秒）");
  }
  if (duration > MAX_DURATION) {
    throw validationError(`时长不能超过 ${MAX_DURATION} 秒`);
  }
  return duration;
}

/** 校验 FPS（正数且 <= 240） */
export function validateTimelineFps(fps: unknown): number {
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    throw validationError("FPS 必须为正数");
  }
  if (fps > MAX_FPS) {
    throw validationError(`FPS 不能超过 ${MAX_FPS}`);
  }
  return fps;
}

/** 校验画布尺寸（均 > 0 且 <= 8192） */
export function validateTimelineDimensions(
  width: unknown,
  height: unknown,
): { width: number; height: number } {
  const w = validateDimension(width, "宽度");
  const h = validateDimension(height, "高度");
  return { width: w, height: h };
}

function validateDimension(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw validationError(`${field}必须为正数`);
  }
  if (value > MAX_DIMENSION) {
    throw validationError(`${field}不能超过 ${MAX_DIMENSION}`);
  }
  if (!Number.isInteger(value)) {
    throw validationError(`${field}必须为整数`);
  }
  return value;
}

/** 校验轨道顺序（规则：order >= 0 整数） */
export function validateTrackOrder(order: unknown): number {
  if (typeof order !== "number" || !Number.isFinite(order) || order < 0 || !Number.isInteger(order)) {
    throw validationError("轨道顺序必须为 >= 0 的整数");
  }
  return order;
}

/** 校验剪辑顺序（规则：order >= 0 整数） */
export function validateClipOrder(order: unknown): number {
  return validateTrackOrder(order);
}

/** 校验 clip 起点（规则 1：startTime >= 0） */
export function validateClipStartTime(startTime: unknown): number {
  if (typeof startTime !== "number" || !Number.isFinite(startTime) || startTime < 0) {
    throw validationError("剪辑起点必须为 >= 0 的数值（秒）");
  }
  return startTime;
}

/** 校验源素材起点（可选；提供时 >= 0） */
export function validateSourceStartTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw validationError("源素材起点必须为 >= 0 的数值（秒）");
  }
  return value;
}

/** 校验源素材截取长度（可选；提供时 > 0） */
export function validateSourceDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return validateTimelineDuration(value);
}

/** 规范可选 metadata（任意对象，禁止数组/null） */
export function normalizeClipMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw validationError("metadata 必须为对象");
  }
  return metadata as Record<string, unknown>;
}

/**
 * 规则 6：剪辑起点不能超过 Timeline 当前时长（防止悬空放置在时间轴范围外）。
 * 剪辑终点允许延伸（end 超过当前 duration 时时间轴随之扩展，见 TimelineService 重算）。
 */
export function assertClipStartsWithinTimeline(
  startTime: number,
  timelineDuration: number,
): void {
  if (startTime > timelineDuration + 1e-9) {
    throw validationError(
      `剪辑起点超出时间轴范围：起点 ${startTime}s > 时间轴当前时长 ${timelineDuration}s`,
    );
  }
}

/**
 * 规则 6：剪辑不能超出 Timeline 最大允许范围。
 * 允许恰好贴边（startTime + duration === timelineDuration）。
 */
export function assertClipWithinTimeline(
  startTime: number,
  duration: number,
  timelineDuration: number,
): void {
  const end = startTime + duration;
  if (end > timelineDuration + 1e-9) {
    throw validationError(
      `剪辑超出时间轴范围：起点 ${startTime}s + 时长 ${duration}s = ${end}s > 时间轴 ${timelineDuration}s`,
    );
  }
}

/**
 * 规则 3/4：轨道类型与资产类型必须匹配。
 * - video 轨道：必须关联 video 资产；
 * - audio 轨道：必须关联 audio 资产；
 * - subtitle / overlay：第一阶段不强制资产绑定（预留类型位），
 *   但若提供了资产，则必须为对应类型（subtitle / image）。
 */
export function assertClipAssetMatchesTrack(
  trackType: TimelineTrackType,
  assetType?: AssetType,
): void {
  if (trackType === "video") {
    if (assetType !== "video") {
      throw validationError(
        assetType === undefined
          ? "视频轨道剪辑必须关联视频资产"
          : `视频轨道剪辑要求 video 资产，实际为 ${assetType}`,
      );
    }
    return;
  }
  if (trackType === "audio") {
    if (assetType !== "audio") {
      throw validationError(
        assetType === undefined
          ? "音频轨道剪辑必须关联音频资产"
          : `音频轨道剪辑要求 audio 资产，实际为 ${assetType}`,
      );
    }
    return;
  }
  if (trackType === "subtitle" && assetType !== undefined && assetType !== "subtitle") {
    throw validationError(`字幕轨道剪辑要求 subtitle 资产，实际为 ${assetType}`);
  }
  if (trackType === "overlay" && assetType !== undefined && assetType !== "image") {
    throw validationError(`叠加轨道剪辑要求 image 资产，实际为 ${assetType}`);
  }
}

/**
 * 规则 7/8：被引用实体必须与 Timeline 同属一个 Project。
 * 纯函数断言，实体由调用方（Service/工具）加载后传入。
 */
export function assertSameProject(
  timelineProjectId: string,
  entityProjectId: string,
  referred: string,
): void {
  if (timelineProjectId !== entityProjectId) {
    throw validationError(`${referred} 不属于当前项目：时间轴项目 ${timelineProjectId} ≠ ${referred} 项目 ${entityProjectId}`);
  }
}

/** 上下文校验所需的实体最小视图（领域不依赖具体持久化类型） */
export interface ClipValidationContext {
  timeline: { duration: number; projectId: string };
  track: { type: TimelineTrackType };
  /** 关联资产（未关联时为 undefined/null） */
  asset?: { type: AssetType; projectId: string } | null;
  /** 关联镜头（未关联时为 undefined/null） */
  shot?: { projectId: string } | null;
}

/**
 * 组合校验：字段级规则 + 上下文规则（3/4/6/7/8）一次执行。
 * 在字段级校验（validateClipStartTime / validateTimelineDuration）之后调用即可。
 */
export function validateClipAgainstContext(
  clip: Pick<TimelineClip, "assetId" | "shotId" | "startTime" | "duration">,
  ctx: ClipValidationContext,
): void {
  if (ctx.track.type === "video" || ctx.track.type === "audio") {
    if (!clip.assetId) {
      throw validationError("video/audio 轨道剪辑必须关联资产");
    }
  }
  assertClipAssetMatchesTrack(ctx.track.type, ctx.asset?.type);
  if (ctx.asset) {
    assertSameProject(ctx.timeline.projectId, ctx.asset.projectId, `资产 ${clip.assetId}`);
  }
  if (ctx.shot) {
    assertSameProject(ctx.timeline.projectId, ctx.shot.projectId, `镜头 ${clip.shotId}`);
  }
  assertClipWithinTimeline(clip.startTime, clip.duration, ctx.timeline.duration);
}
