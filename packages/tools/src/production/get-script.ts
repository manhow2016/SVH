/**
 * get_script 工具（文档 §10.2）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, requireProjectInWorkspace, requiredString } from "./utils";

export interface GetScriptToolDeps {
  production: ProductionService;
}

export function getScriptTool({ production }: GetScriptToolDeps): Tool {
  return {
    name: "get_script",
    description: "获取项目的指定剧本（按剧本 id）。",
    inputSchema: {
      type: "object",
      properties: { scriptId: { type: "string", description: "剧本 id（必填）" } },
      required: ["scriptId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const scriptId = requiredString(raw, "scriptId");
      const script = await production.getScript(scriptId);
      await requireProjectInWorkspace(production, script.projectId, context.workspaceId);
      return asResult(script);
    },
  };
}
