/**
 * get_project 工具（文档 §10.1）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, requireProjectInWorkspace, requiredString } from "./utils";

export interface GetProjectToolDeps {
  production: ProductionService;
}

export function getProjectTool({ production }: GetProjectToolDeps): Tool {
  return {
    name: "get_project",
    description: "获取当前工作区内的生产项目详情（按项目 id）。",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "项目 id" } },
      required: ["projectId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      const project = await requireProjectInWorkspace(production, projectId, context.workspaceId);
      return asResult(project);
    },
  };
}
