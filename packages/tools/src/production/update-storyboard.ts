/**
 * update_storyboard 工具（文档 §10.4）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, optionalNumber, optionalString, requireProjectInWorkspace, requiredString } from "./utils";

export interface UpdateStoryboardToolDeps {
  production: ProductionService;
}

export function updateStoryboardTool({ production }: UpdateStoryboardToolDeps): Tool {
  return {
    name: "update_storyboard",
    description:
      "更新分镜（描述/时长/景别/运镜/提示词/状态）。注意：分镜总时长不得低于其下镜头时长之和；状态 draft↔approved。",
    inputSchema: {
      type: "object",
      properties: {
        storyboardId: { type: "string", description: "分镜 id（必填）" },
        description: { type: "string" },
        duration: { type: "number", description: "分镜时长（秒）" },
        shotType: { type: "string" },
        cameraMovement: { type: "string" },
        imagePrompt: { type: "string" },
        videoPrompt: { type: "string" },
        order: { type: "number" },
        status: { type: "string", enum: ["draft", "approved"] },
      },
      required: ["storyboardId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const storyboardId = requiredString(raw, "storyboardId");
      const current = await production.getStoryboard(storyboardId);
      await requireProjectInWorkspace(production, current.projectId, context.workspaceId);
      const storyboard = await production.updateStoryboard(storyboardId, {
        description: optionalString(raw, "description"),
        duration: optionalNumber(raw, "duration"),
        shotType: optionalString(raw, "shotType"),
        cameraMovement: optionalString(raw, "cameraMovement"),
        imagePrompt: optionalString(raw, "imagePrompt"),
        videoPrompt: optionalString(raw, "videoPrompt"),
        order: optionalNumber(raw, "order"),
        status: optionalString(raw, "status") as "draft" | undefined,
      });
      return asResult(storyboard);
    },
  };
}
