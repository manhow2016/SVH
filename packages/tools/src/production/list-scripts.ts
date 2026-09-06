/**
 * list_scripts 工具（文档 §10.2）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, requireProjectInWorkspace, requiredString } from "./utils";

export interface ListScriptsToolDeps {
  production: ProductionService;
}

export function listScriptsTool({ production }: ListScriptsToolDeps): Tool {
  return {
    name: "list_scripts",
    description: "列出项目的全部剧本（按项目 id）。",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "项目 id（必填）" } },
      required: ["projectId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const scripts = await production.listScripts(projectId);
      return asResult(scripts);
    },
  };
}
