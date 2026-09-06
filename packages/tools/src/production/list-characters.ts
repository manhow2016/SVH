/**
 * list_characters 工具（文档 §10.3）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, requireProjectInWorkspace, requiredString } from "./utils";

export interface ListCharactersToolDeps {
  production: ProductionService;
}

export function listCharactersTool({ production }: ListCharactersToolDeps): Tool {
  return {
    name: "list_characters",
    description: "列出项目的全部角色（按项目 id）。",
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
      const characters = await production.listCharacters(projectId);
      return asResult(characters);
    },
  };
}
