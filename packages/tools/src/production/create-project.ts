/**
 * create_project 工具（文档 §10.1）。
 *
 * 在当前工作区创建一个 Production Project，返回项目实体（含 id）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, optionalNumber, optionalString, requiredString } from "./utils";

export interface CreateProjectToolDeps {
  production: ProductionService;
}

export function createProjectTool({ production }: CreateProjectToolDeps): Tool {
  return {
    name: "create_project",
    description:
      "创建 AI 短剧生产项目（属于当前工作区）。输入项目名称、类型（short_video/short_drama/animation/advertisement）、目标时长与风格，返回项目 id。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "项目名称（必填）" },
        type: {
          type: "string",
          enum: ["short_video", "short_drama", "animation", "advertisement"],
          description: "项目类型，默认 short_drama",
        },
        description: { type: "string", description: "项目说明" },
        duration: { type: "number", description: "目标时长（秒）" },
        style: { type: "string", description: "视觉/叙事风格，如 chinese_fantasy" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const name = requiredString(raw, "name");
      const project = await production.createProject({
        workspaceId: context.workspaceId,
        name,
        type: optionalString(raw, "type") as "short_drama" | undefined,
        description: optionalString(raw, "description"),
        settings: {
          duration: optionalNumber(raw, "duration"),
          style: optionalString(raw, "style"),
        },
      });
      return asResult(project);
    },
  };
}
