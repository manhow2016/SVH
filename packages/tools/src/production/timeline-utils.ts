/**
 * Timeline 工具公共辅助（V0.3 文档 Phase 6：时间轴工具）。
 *
 * 归属校验沿「timeline → project → workspace」链（与 utils.requireProjectInWorkspace
 * 同语义）：时间轴不存在抛「时间轴 不存在」；时间轴所属项目不属当前工作区时按
 * 「项目 不存在」隐藏存在性（与路由层 assertTimelineOwned 一致）。
 *
 * 另含解绑专用输入解析：assetId / shotId 允许显式 null（= 解除绑定）。
 */
import type {
  ProductionService,
  ProductionTimeline,
  TimelineService,
  TimelineTrack,
  TimelineClip,
} from "@svh/production";
import { ToolError } from "../tool";
import { requireProjectInWorkspace } from "./utils";

/** 时间轴归属校验：加载时间轴并确认其项目归属当前工作区 */
export async function requireTimelineInWorkspace(
  production: ProductionService,
  timeline: TimelineService,
  timelineId: string,
  workspaceId: string,
): Promise<ProductionTimeline> {
  const found = await timeline.getTimeline(timelineId);
  await requireProjectInWorkspace(production, found.projectId, workspaceId);
  return found;
}

/** 轨道归属校验：加载轨道 → 归属到时间轴 → 时间轴归属工作区 */
export async function requireTrackInWorkspace(
  production: ProductionService,
  timeline: TimelineService,
  trackId: string,
  workspaceId: string,
): Promise<TimelineTrack> {
  const track = await timeline.getTrack(trackId);
  await requireTimelineInWorkspace(production, timeline, track.timelineId, workspaceId);
  return track;
}

/** 剪辑归属校验：加载剪辑 → 归属到时间轴 → 时间轴归属工作区 */
export async function requireClipInWorkspace(
  production: ProductionService,
  timeline: TimelineService,
  clipId: string,
  workspaceId: string,
): Promise<TimelineClip> {
  const clip = await timeline.getClip(clipId);
  await requireTimelineInWorkspace(production, timeline, clip.timelineId, workspaceId);
  return clip;
}

/**
 * 可选字符串字段（关联列专用）：undefined = 不传（不动）；
 * null = 显式解绑（写入 SQL NULL）；空串按 undefined 处理（避免误传空串解绑）。
 */
export function optionalNullableString(
  input: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ToolError("INVALID_INPUT", `${key} 必须为字符串或 null`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
