/**
 * list_projects 工具（文档 §10.1）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult } from "./utils";

export interface ListProjectsToolDeps {
  production: ProductionService;
}

export function listProjectsTool({ production }: ListProjectsToolDeps): Tool {
  return {
    name: "list_projects",
    description: "列出当前工作区的全部生产项目。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, context) {
      const projects = await production.listProjects(context.workspaceId);
      return asResult(projects);
    },
  };
}
