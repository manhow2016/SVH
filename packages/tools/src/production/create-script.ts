/**
 * create_script 工具（文档 §10.2）。
 */
import type { Tool } from "../tool";
import type { ProductionService, ScriptStatus } from "@svh/production";
import { asResult, inputRecord, optionalString, requireProjectInWorkspace, requiredString } from "./utils";

export interface CreateScriptToolDeps {
  production: ProductionService;
}

export function createScriptTool({ production }: CreateScriptToolDeps): Tool {
  return {
    name: "create_script",
    description:
      "为项目创建剧本（版本 v1，状态默认 draft）。禁止用本工具生成图片/视频。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        title: { type: "string", description: "剧本标题（必填）" },
        content: { type: "string", description: "剧本正文（必填，含场景与对白）" },
        status: { type: "string", enum: ["draft", "reviewing", "approved"] },
      },
      required: ["projectId", "title", "content"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const script = await production.createScript({
        projectId,
        title: requiredString(raw, "title"),
        content: requiredString(raw, "content"),
        status: optionalString(raw, "status") as ScriptStatus | undefined,
      });
      return asResult(script);
    },
  };
}
