/**
 * update_timeline_clip 工具（V0.3 文档 Phase 6）。
 *
 * assetId / shotId 支持显式 null（= 解除绑定）；其余字段 undefined 即不动。
 * 时长/起点变更后时间轴 duration 自动重算、version +1。
 */
import type { Tool } from "../tool";
import type { ProductionService, TimelineService } from "@svh/production";
import { asResult, inputRecord, optionalNumber, requiredString } from "./utils";
import { optionalNullableString, requireClipInWorkspace } from "./timeline-utils";

export interface UpdateTimelineClipToolDeps {
  production: ProductionService;
  timeline: TimelineService;
}

export function updateTimelineClipTool({ production, timeline }: UpdateTimelineClipToolDeps): Tool {
  return {
    name: "update_timeline_clip",
    description:
      "更新剪辑字段（至少一个）：assetId/shotId（传 null 解除绑定）、startTime、duration、" +
      "sourceStartTime、sourceDuration、order。编辑期起点不得超过时间轴当前时长，终点可延伸；" +
      "video/audio 轨道剪辑不可失去资产绑定（解绑后再更新会被拒绝）。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "剪辑 id（必填）" },
        assetId: { type: ["string", "null"], description: "生产资产 id（null = 解除绑定）" },
        shotId: { type: ["string", "null"], description: "来源镜头 id（null = 解除绑定）" },
        startTime: { type: "number", description: "时间轴起点（秒，>= 0）" },
        duration: { type: "number", description: "持续时间（秒，> 0）" },
        sourceStartTime: { type: "number", description: "源素材内起始偏移（秒）" },
        sourceDuration: { type: "number", description: "源素材内截取长度（秒）" },
        order: { type: "number", description: "轨道内顺序（0 起）" },
      },
      required: ["clipId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const clipId = requiredString(raw, "clipId");
      await requireClipInWorkspace(production, timeline, clipId, context.workspaceId);
      const result = await timeline.updateClip(clipId, {
        assetId: optionalNullableString(raw, "assetId"),
        shotId: optionalNullableString(raw, "shotId"),
        startTime: optionalNumber(raw, "startTime"),
        duration: optionalNumber(raw, "duration"),
        sourceStartTime: optionalNumber(raw, "sourceStartTime"),
        sourceDuration: optionalNumber(raw, "sourceDuration"),
        order: optionalNumber(raw, "order"),
      });
      return asResult(result);
    },
  };
}
