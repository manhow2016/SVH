/**
 * create_timeline 工具（V0.3 文档 Phase 6）。
 */
import type { Tool } from "../tool";
import type { ProductionService, TimelineService } from "@svh/production";
import {
  asResult,
  inputRecord,
  optionalNumber,
  optionalString,
  requireProjectInWorkspace,
  requiredString,
} from "./utils";

export interface CreateTimelineToolDeps {
  production: ProductionService;
  timeline: TimelineService;
}

export function createTimelineTool({ production, timeline }: CreateTimelineToolDeps): Tool {
  return {
    name: "create_timeline",
    description:
      "为项目创建成片时间轴（Project → Timeline → Track → Clip）。创建后为空草稿（draft，version 0），随后用 add_timeline_track / add_timeline_clip 组装内容。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        name: { type: "string", description: "时间轴名称（必填）" },
        description: { type: "string", description: "时间轴描述" },
        fps: { type: "number", description: "帧率（默认 24）" },
        width: { type: "number", description: "画面宽度（默认 1920）" },
        height: { type: "number", description: "画面高度（默认 1080）" },
      },
      required: ["projectId", "name"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const result = await timeline.createTimeline({
        projectId,
        name: requiredString(raw, "name"),
        description: optionalString(raw, "description"),
        fps: optionalNumber(raw, "fps"),
        width: optionalNumber(raw, "width"),
        height: optionalNumber(raw, "height"),
      });
      return asResult(result);
    },
  };
}
