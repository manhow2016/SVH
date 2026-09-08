/**
 * add_timeline_track 工具（V0.3 文档 Phase 6）。
 */
import type { Tool } from "../tool";
import type { ProductionService, TimelineService } from "@svh/production";
import { asResult, inputRecord, optionalNumber, requiredString } from "./utils";
import { requireTimelineInWorkspace } from "./timeline-utils";

export interface AddTimelineTrackToolDeps {
  production: ProductionService;
  timeline: TimelineService;
}

export function addTimelineTrackTool({ production, timeline }: AddTimelineTrackToolDeps): Tool {
  return {
    name: "add_timeline_track",
    description:
      "向时间轴添加轨道（类型 video / audio / subtitle / overlay；第一阶段仅 video、audio 实际使用）。轨道纵向顺序 order 缺省追加到末尾。",
    inputSchema: {
      type: "object",
      properties: {
        timelineId: { type: "string", description: "时间轴 id（必填）" },
        type: {
          type: "string",
          enum: ["video", "audio", "subtitle", "overlay"],
          description: "轨道类型（必填）",
        },
        name: { type: "string", description: "轨道名称（必填）" },
        order: { type: "number", description: "轨道顺序（0 起，缺省追加末尾）" },
        muted: { type: "boolean", description: "是否静音" },
        locked: { type: "boolean", description: "是否锁定" },
      },
      required: ["timelineId", "type", "name"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const timelineId = requiredString(raw, "timelineId");
      await requireTimelineInWorkspace(production, timeline, timelineId, context.workspaceId);
      const result = await timeline.createTrack({
        timelineId,
        type: requiredString(raw, "type") as never,
        name: requiredString(raw, "name"),
        order: optionalNumber(raw, "order"),
      });
      return asResult(result);
    },
  };
}
