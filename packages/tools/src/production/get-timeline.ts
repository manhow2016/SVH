/**
 * get_timeline 工具（V0.3 文档 Phase 6）。
 *
 * 返回时间轴详情聚合：timeline（含派生 duration/version）+ tracks + clips。
 */
import type { Tool } from "../tool";
import type { ProductionService, TimelineService } from "@svh/production";
import { asResult, inputRecord, requiredString } from "./utils";
import { requireTimelineInWorkspace } from "./timeline-utils";

export interface GetTimelineToolDeps {
  production: ProductionService;
  timeline: TimelineService;
}

export function getTimelineTool({ production, timeline }: GetTimelineToolDeps): Tool {
  return {
    name: "get_timeline",
    description:
      "查询时间轴详情：timeline（名称/时长 duration/帧率/尺寸/状态/版本）+ tracks 轨道 + clips 剪辑（含 startTime、duration、assetId、shotId）。",
    inputSchema: {
      type: "object",
      properties: {
        timelineId: { type: "string", description: "时间轴 id（必填）" },
      },
      required: ["timelineId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const timelineId = requiredString(raw, "timelineId");
      await requireTimelineInWorkspace(production, timeline, timelineId, context.workspaceId);
      const detail = await timeline.getTimelineDetail(timelineId);
      return asResult(detail);
    },
  };
}
