/**
 * Timeline 领域规则（V0.3 文档 §四-1、§五）。
 *
 * 状态机：draft → editing → ready → rendering → completed | failed；
 * ready 之前的草稿/编辑阶段允许自由回退；rendering 中禁止修改（由状态约束，
 * 编辑动作在 Service 层以状态前置校验拦截）。
 */
import { conflictError, validationError } from "../errors";
import type { CreateTimelineClipInput, CreateTimelineInput, CreateTimelineTrackInput, TimelineStatus } from "./timeline-types";
import {
  DEFAULT_TIMELINE_FPS,
  DEFAULT_TIMELINE_HEIGHT,
  DEFAULT_TIMELINE_WIDTH,
  TIMELINE_TRACK_TYPES,
  isTimelineTrackType,
  normalizeClipMetadata,
  validateClipOrder,
  validateClipStartTime,
  validateSourceDuration,
  validateSourceStartTime,
  validateTimelineDescription,
  validateTimelineDimensions,
  validateTimelineDuration,
  validateTimelineFps,
  validateTimelineName,
  validateTrackOrder,
} from "./timeline-validation";

/**
 * Timeline 状态机转换表。
 * - 草稿/编辑/就绪：内容可往复调整（用户编辑、自动生成、回退）；
 * - rendering：只可到 completed / failed；
 * - completed / failed：允许回退再编辑或重渲染。
 */
const TIMELINE_TRANSITIONS: Readonly<Record<TimelineStatus, readonly TimelineStatus[]>> = {
  draft: ["editing", "ready"],
  editing: ["draft", "ready"],
  ready: ["editing", "rendering"],
  rendering: ["completed", "failed"],
  completed: ["editing", "ready"],
  failed: ["editing", "ready"],
};

export function canTransitionTimelineStatus(from: TimelineStatus, to: TimelineStatus): boolean {
  return (TIMELINE_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** 应用状态跳转（同状态为 no-op；非法跳转抛 CONFLICT） */
export function applyTimelineStatus(from: TimelineStatus, to: TimelineStatus): TimelineStatus {
  if (from === to) {
    return from;
  }
  if (!canTransitionTimelineStatus(from, to)) {
    throw conflictError(`时间轴状态不允许从 ${from} 变更到 ${to}`);
  }
  return to;
}

/** 编辑版本号：内容每次变更 +1（版本号必须 >= 0，防异常回退） */
export function bumpTimelineVersion(version: number): number {
  if (!Number.isInteger(version) || version < 0) {
    throw validationError("时间轴版本号必须为 >= 0 的整数");
  }
  return version + 1;
}

/**
 * 规范化创建输入（填充默认渲染目标）。
 * 返回可直接入库的字段（不含 id / 时间戳 / status / version）。
 */
export function normalizeTimelineCreateInput(input: CreateTimelineInput) {
  const fps = validateTimelineFps(input.fps ?? DEFAULT_TIMELINE_FPS);
  const { width, height } = validateTimelineDimensions(
    input.width ?? DEFAULT_TIMELINE_WIDTH,
    input.height ?? DEFAULT_TIMELINE_HEIGHT,
  );
  return {
    projectId: input.projectId,
    name: validateTimelineName(input.name),
    description: validateTimelineDescription(input.description),
    duration: 0,
    fps,
    width,
    height,
  };
}

/** 规范化轨道创建输入（校验类型/名称/顺序） */
export function normalizeTimelineTrackCreateInput(input: CreateTimelineTrackInput) {
  if (!isTimelineTrackType(input.type)) {
    throw validationError(`轨道类型必须是 ${TIMELINE_TRACK_TYPES.join(" / ")} 之一`);
  }
  const name = validateTimelineName(input.name);
  const order = input.order === undefined ? undefined : validateTrackOrder(input.order);
  const out: {
    timelineId: string;
    type: CreateTimelineTrackInput["type"];
    name: string;
    order?: number;
    muted?: boolean;
    locked?: boolean;
  } = {
    timelineId: input.timelineId,
    type: input.type,
    name,
    order,
    muted: input.muted,
    locked: input.locked,
  };
  return out;
}

/**
 * 规范化剪辑创建输入（字段级校验：规则 1/2）。
 * 上下文规则（3/4/6/7/8）由 Service 加载实体后调用
 * `validateClipAgainstContext` / `assertClip*` 执行。
 */
export function normalizeTimelineClipCreateInput(input: CreateTimelineClipInput) {
  const startTime = validateClipStartTime(input.startTime);
  const duration = validateTimelineDuration(input.duration);
  const order = input.order === undefined ? undefined : validateClipOrder(input.order);
  const sourceStartTime =
    input.sourceStartTime === undefined ? undefined : validateSourceStartTime(input.sourceStartTime);
  const sourceDuration =
    input.sourceDuration === undefined ? undefined : validateSourceDuration(input.sourceDuration);
  return {
    timelineId: input.timelineId,
    trackId: input.trackId,
    assetId: input.assetId,
    shotId: input.shotId,
    startTime,
    duration,
    sourceStartTime,
    sourceDuration,
    order,
    metadata: normalizeClipMetadata(input.metadata),
  };
}
