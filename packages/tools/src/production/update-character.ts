/**
 * update_character 工具（文档 §10.3）。
 */
import type { Tool } from "../tool";
import type { CharacterAppearance, CharacterVisualProfile, ProductionService } from "@svh/production";
import {
  asResult,
  inputRecord,
  optionalObject,
  optionalString,
  requireProjectInWorkspace,
  requiredString,
} from "./utils";

export interface UpdateCharacterToolDeps {
  production: ProductionService;
}

export function updateCharacterTool({ production }: UpdateCharacterToolDeps): Tool {
  return {
    name: "update_character",
    description: "更新角色（名称/描述/外观/personality/referenceAssetId/visualProfile）。",
    inputSchema: {
      type: "object",
      properties: {
        characterId: { type: "string", description: "角色 id（必填）" },
        name: { type: "string" },
        description: { type: "string" },
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
        personality: { type: "string" },
        referenceAssetId: { type: "string" },
        visualProfile: {
          type: "object",
          description: "角色视觉档案（稳定 Prompt Anchor / 参考图）",
          properties: {
            appearancePrompt: { type: "string" },
            identityPrompt: { type: "string" },
            costumePrompt: { type: "string" },
            stylePrompt: { type: "string" },
            negativePrompt: { type: "string" },
            referenceAssetIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["characterId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const characterId = requiredString(raw, "characterId");
      const current = await production.getCharacter(characterId);
      await requireProjectInWorkspace(production, current.projectId, context.workspaceId);
      const character = await production.updateCharacter(characterId, {
        name: optionalString(raw, "name"),
        description: optionalString(raw, "description"),
        appearance: optionalObject(raw, "appearance") as CharacterAppearance | undefined,
        personality: optionalString(raw, "personality"),
        referenceAssetId: optionalString(raw, "referenceAssetId"),
        visualProfile: optionalObject(raw, "visualProfile") as CharacterVisualProfile | undefined,
      });
      return asResult(character);
    },
  };
}
