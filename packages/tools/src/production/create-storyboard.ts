/**
 * create_storyboard 工具（文档 §10.4）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, optionalNumber, optionalString, requireProjectInWorkspace, requiredNumber, requiredString } from "./utils";

export interface CreateStoryboardToolDeps {
  production: ProductionService;
}

export function createStoryboardTool({ production }: CreateStoryboardToolDeps): Tool {
  return {
    name: "create_storyboard",
    description:
      "为场景创建分镜。duration 为该分镜总时长（秒）；shotType 为景别/运镜（如 medium_shot/slow_push_in）；imagePrompt/videoPrompt 为后续生成提示词。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        sceneId: { type: "string", description: "场景 id（必填）" },
        description: { type: "string", description: "分镜描述（必填）" },
        duration: { type: "number", description: "分镜时长（秒，必填）" },
        shotType: { type: "string", description: "景别/运镜（必填）" },
        order: { type: "number", description: "顺序（0 起，缺省自动排最末）" },
        cameraMovement: { type: "string" },
        imagePrompt: { type: "string", description: "文生图提示词" },
        videoPrompt: { type: "string", description: "文生视频提示词" },
      },
      required: ["projectId", "sceneId", "description", "duration", "shotType"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const storyboard = await production.createStoryboard({
        projectId,
        sceneId: requiredString(raw, "sceneId"),
        description: requiredString(raw, "description"),
        duration: requiredNumber(raw, "duration"),
        shotType: requiredString(raw, "shotType"),
        order: optionalNumber(raw, "order"),
        cameraMovement: optionalString(raw, "cameraMovement"),
        imagePrompt: optionalString(raw, "imagePrompt"),
        videoPrompt: optionalString(raw, "videoPrompt"),
      });
      return asResult(storyboard);
    },
  };
}
