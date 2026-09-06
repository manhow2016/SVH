/**
 * update_script 工具（文档 §10.2）。
 */
import type { Tool } from "../tool";
import type { ProductionService, ScriptStatus } from "@svh/production";
import { asResult, inputRecord, optionalString, requireProjectInWorkspace, requiredString } from "./utils";

export interface UpdateScriptToolDeps {
  production: ProductionService;
}

export function updateScriptTool({ production }: UpdateScriptToolDeps): Tool {
  return {
    name: "update_script",
    description:
      "更新剧本（标题/内容/状态）。内容变更时版本号自动 +1 且状态回退 draft；状态流转：draft→reviewing→approved，approved/reviewing 可退回 draft。",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", description: "剧本 id（必填）" },
        title: { type: "string" },
        content: { type: "string" },
        status: { type: "string", enum: ["draft", "reviewing", "approved"] },
      },
      required: ["scriptId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const scriptId = requiredString(raw, "scriptId");
      const current = await production.getScript(scriptId);
      await requireProjectInWorkspace(production, current.projectId, context.workspaceId);
      const script = await production.updateScript(scriptId, {
        title: optionalString(raw, "title"),
        content: optionalString(raw, "content"),
        status: optionalString(raw, "status") as ScriptStatus | undefined,
      });
      return asResult(script);
    },
  };
}
