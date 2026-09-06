/**
 * create_character 工具（文档 §10.3）。
 */
import type { Tool } from "../tool";
import type { CharacterAppearance, ProductionService } from "@svh/production";
import {
  asResult,
  inputRecord,
  optionalObject,
  optionalString,
  requireProjectInWorkspace,
  requiredString,
} from "./utils";

export interface CreateCharacterToolDeps {
  production: ProductionService;
}

export function createCharacterTool({ production }: CreateCharacterToolDeps): Tool {
  return {
    name: "create_character",
    description:
      "为项目创建角色。appearance 支持字段：gender/age/hairstyle/clothing/facialFeatures/style（均为字符串）；referenceAssetId 为参考图资产 id。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        name: { type: "string", description: "角色名（必填）" },
        description: { type: "string", description: "角色描述（必填）" },
        appearance: {
          type: "object",
          properties: {
            gender: { type: "string" },
            age: { type: "string" },
            hairstyle: { type: "string" },
            clothing: { type: "string" },
            facialFeatures: { type: "string" },
            style: { type: "string" },
          },
        },
        personality: { type: "string", description: "性格特点" },
        referenceAssetId: { type: "string", description: "参考图资产 id" },
      },
      required: ["projectId", "name", "description"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const character = await production.createCharacter({
        projectId,
        name: requiredString(raw, "name"),
        description: requiredString(raw, "description"),
        appearance: optionalObject(raw, "appearance") as CharacterAppearance | undefined,
        personality: optionalString(raw, "personality"),
        referenceAssetId: optionalString(raw, "referenceAssetId"),
      });
      return asResult(character);
    },
  };
}
