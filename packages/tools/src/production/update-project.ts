/**
 * update_project 工具（文档 §10.1）。
 */
import type { Tool } from "../tool";
import type { ProductionProjectSettings, ProductionService } from "@svh/production";
import { asResult, inputRecord, optionalNumber, optionalString, requireProjectInWorkspace, requiredString } from "./utils";

export interface UpdateProjectToolDeps {
  production: ProductionService;
}

export function updateProjectTool({ production }: UpdateProjectToolDeps): Tool {
  return {
    name: "update_project",
    description:
      "更新生产项目（名称/类型/描述/状态/时长/风格）。状态合法流转：draft→planning→producing→completed，任意状态可归档 archived，archived 可重开为 draft。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["short_video", "short_drama", "animation", "advertisement"],
        },
        description: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "planning", "producing", "completed", "archived"],
        },
        duration: { type: "number", description: "目标时长（秒）" },
        style: { type: "string" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      // 仅在显式传入时长/风格时才更新 settings，避免覆盖既有配置
      const duration = optionalNumber(raw, "duration");
      const style = optionalString(raw, "style");
      const settings: ProductionProjectSettings | undefined =
        duration === undefined && style === undefined ? undefined : { duration, style };
      const project = await production.updateProject(projectId, {
        name: optionalString(raw, "name"),
        type: optionalString(raw, "type") as "short_drama" | undefined,
        description: optionalString(raw, "description"),
        status: optionalString(raw, "status") as "draft" | undefined,
        settings,
      });
      return asResult(project);
    },
  };
}
