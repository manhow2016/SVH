/**
 * create_scene 工具（文档 §10.4）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import {
  asResult,
  inputRecord,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireProjectInWorkspace,
  requiredString,
} from "./utils";

export interface CreateSceneToolDeps {
  production: ProductionService;
}

export function createSceneTool({ production }: CreateSceneToolDeps): Tool {
  return {
    name: "create_scene",
    description:
      "为项目创建场景。characters 为出场角色 id 数组；scriptId 可选关联剧本；order 缺省自动排在最末。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        name: { type: "string", description: "场景名称（必填）" },
        description: { type: "string", description: "场景描述（必填）" },
        scriptId: { type: "string", description: "关联剧本 id" },
        order: { type: "number", description: "出场顺序（0 起）" },
        location: { type: "string", description: "地点" },
        time: { type: "string", description: "时间" },
        characters: { type: "array", items: { type: "string" }, description: "出场角色 id 列表" },
      },
      required: ["projectId", "name", "description"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const scene = await production.createScene({
        projectId,
        name: requiredString(raw, "name"),
        description: requiredString(raw, "description"),
        scriptId: optionalString(raw, "scriptId"),
        order: optionalNumber(raw, "order"),
        location: optionalString(raw, "location"),
        time: optionalString(raw, "time"),
        characters: optionalStringArray(raw, "characters"),
      });
      return asResult(scene);
    },
  };
}
