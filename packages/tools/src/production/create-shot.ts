/**
 * create_shot 工具（文档 §10.4）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import {
  asResult,
  inputRecord,
  optionalNumber,
  optionalString,
  requireProjectInWorkspace,
  requiredNumber,
  requiredString,
} from "./utils";

export interface CreateShotToolDeps {
  production: ProductionService;
}

export function createShotTool({ production }: CreateShotToolDeps): Tool {
  return {
    name: "create_shot",
    description:
      "为分镜创建镜头（一个分镜可含多个镜头）。同一分镜下镜头时长之和不得超过分镜总时长；初始状态 pending。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        storyboardId: { type: "string", description: "分镜 id（必填）" },
        duration: { type: "number", description: "镜头时长（秒，必填）" },
        order: { type: "number", description: "顺序（0 起，缺省自动排最末）" },
        framing: { type: "string", description: "景别" },
        cameraMovement: { type: "string", description: "运镜" },
        action: { type: "string", description: "动作" },
        dialogue: { type: "string", description: "对白" },
      },
      required: ["projectId", "storyboardId", "duration"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const shot = await production.createShot({
        projectId,
        storyboardId: requiredString(raw, "storyboardId"),
        duration: requiredNumber(raw, "duration"),
        order: optionalNumber(raw, "order"),
        framing: optionalString(raw, "framing"),
        cameraMovement: optionalString(raw, "cameraMovement"),
        action: optionalString(raw, "action"),
        dialogue: optionalString(raw, "dialogue"),
      });
      return asResult(shot);
    },
  };
}
