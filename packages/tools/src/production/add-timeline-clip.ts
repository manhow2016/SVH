/**
 * add_timeline_clip 工具（V0.3 文档 Phase 6）。
 *
 * 剪辑规则（领域校验，违反抛错）：
 * - video/audio 轨道必须绑定同类型资产（assetId 必传）；
 * - assetId / shotId 必须与时间轴同项目；
 * - startTime 不得超过时间轴当前时长（终点允许延伸时间轴）。
 */
import type { Tool } from "../tool";
import type { ProductionService, TimelineService } from "@svh/production";
import {
  asResult,
  inputRecord,
  optionalNumber,
  optionalString,
  requiredNumber,
  requiredString,
} from "./utils";
import { requireTimelineInWorkspace, requireTrackInWorkspace } from "./timeline-utils";

export interface AddTimelineClipToolDeps {
  production: ProductionService;
  timeline: TimelineService;
}

export function addTimelineClipTool({ production, timeline }: AddTimelineClipToolDeps): Tool {
  return {
    name: "add_timeline_clip",
    description:
      "向轨道添加剪辑。规则：video/audio 轨道必须关联同类型资产（assetId）；assetId/shotId 必须属于该时间轴所在项目；" +
      "startTime 不得超过时间轴当前时长（剪辑终点可延伸时间轴）。duration 为时间轴上占据的秒数，" +
      "sourceStartTime/sourceDuration 为源素材截取区间（缺省整段）。",
    inputSchema: {
      type: "object",
      properties: {
        timelineId: { type: "string", description: "时间轴 id（必填）" },
        trackId: { type: "string", description: "轨道 id（必填）" },
        assetId: { type: "string", description: "生产资产 id（video 轨须 video 资产，audio 轨须 audio 资产）" },
        shotId: { type: "string", description: "来源镜头 id（可选，便于回查）" },
        startTime: { type: "number", description: "时间轴起点（秒，必填，>= 0）" },
        duration: { type: "number", description: "持续时间（秒，必填，> 0）" },
        sourceStartTime: { type: "number", description: "源素材内起始偏移（秒，>= 0）" },
        sourceDuration: { type: "number", description: "源素材内截取长度（秒，> 0）" },
        order: { type: "number", description: "轨道内顺序（0 起，缺省追加末尾）" },
      },
      required: ["timelineId", "trackId", "startTime", "duration"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const timelineId = requiredString(raw, "timelineId");
      const trackId = requiredString(raw, "trackId");
      // 先解析全部输入（必填缺失/类型错 → INVALID_INPUT），再做归属校验
      const clipInput = {
        timelineId,
        trackId,
        assetId: optionalString(raw, "assetId"),
        shotId: optionalString(raw, "shotId"),
        startTime: requiredNumber(raw, "startTime"),
        duration: requiredNumber(raw, "duration"),
        sourceStartTime: optionalNumber(raw, "sourceStartTime"),
        sourceDuration: optionalNumber(raw, "sourceDuration"),
        order: optionalNumber(raw, "order"),
      };
      await requireTimelineInWorkspace(production, timeline, timelineId, context.workspaceId);
      await requireTrackInWorkspace(production, timeline, trackId, context.workspaceId);
      const result = await timeline.createClip(clipInput);
      return asResult(result);
    },
  };
}
