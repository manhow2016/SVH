/**
 * auto_create_timeline 工具（V0.3 文档 Phase 5/6）。
 *
 * 一键按项目镜头自动生成成片时间轴：scene.order → storyboard.order →
 * shot.order 排序；每镜头优先使用 shot.videoAssetId（用户/审核选中），
 * 否则该镜头最新完成的视频生成记录；无素材镜头跳过（结果含 skipped 说明）。
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

export interface AutoCreateTimelineToolDeps {
  production: ProductionService;
  timeline: TimelineService;
}

export function autoCreateTimelineTool({ production, timeline }: AutoCreateTimelineToolDeps): Tool {
  return {
    name: "auto_create_timeline",
    description:
      "按项目镜头自动生成成片时间轴（单条视频轨，镜头按场景→分镜→镜头顺序累计拼接）。" +
      "素材规则：优先镜头已选中的 video 资产（shot.videoAssetId），否则该镜头最新完成生成的视频；" +
      "无素材的镜头自动跳过并写入 skipped 列表。返回 timeline + tracks + clips + skipped。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        name: { type: "string", description: "时间轴名称（缺省「自动时间轴 YYYY-MM-DD HH:mm」）" },
        description: { type: "string", description: "时间轴描述" },
        fps: { type: "number", description: "帧率（默认 24）" },
        width: { type: "number", description: "画面宽度（默认 1920）" },
        height: { type: "number", description: "画面高度（默认 1080）" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const result = await timeline.autoCreateTimeline(projectId, {
        name: optionalString(raw, "name"),
        description: optionalString(raw, "description"),
        fps: optionalNumber(raw, "fps"),
        width: optionalNumber(raw, "width"),
        height: optionalNumber(raw, "height"),
      });
      return asResult(result);
    },
  };
}
