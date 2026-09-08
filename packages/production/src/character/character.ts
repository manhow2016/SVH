/**
 * Character 领域规则：校验与外观字段白名单规范化（文档 §6.3）。
 */
import type { CharacterAppearance, CharacterVisualProfile } from "./character-types";
import { validationError } from "../errors";

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_TEXT_LENGTH = 500;
const MAX_COSTUME_LENGTH = 1000;

/** 外观字段白名单（只保留已知字段且值必须为字符串） */
const APPEARANCE_KEYS: readonly (keyof CharacterAppearance)[] = [
  "gender",
  "age",
  "hairstyle",
  "clothing",
  "facialFeatures",
  "style",
];

/** 视觉档案文本字段白名单（排除 referenceAssetIds 数组字段） */
type VisualProfileTextKey =
  | "appearancePrompt"
  | "identityPrompt"
  | "costumePrompt"
  | "stylePrompt"
  | "negativePrompt";

const VISUAL_PROFILE_TEXT_KEYS: readonly VisualProfileTextKey[] = [
  "appearancePrompt",
  "identityPrompt",
  "costumePrompt",
  "stylePrompt",
  "negativePrompt",
];

/** 校验并规范角色视觉档案（V0.3 Phase 3）；空对象/缺省返回 undefined */
export function normalizeVisualProfile(input?: unknown): CharacterVisualProfile | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("角色视觉档案必须为对象");
  }
  const raw = input as Partial<CharacterVisualProfile>;
  const profile: CharacterVisualProfile = {};

  for (const key of VISUAL_PROFILE_TEXT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw validationError(`视觉档案字段 ${key} 必须为字符串`);
    }
    const trimmed = value.trim();
    if (trimmed !== "") {
      profile[key] = trimmed.slice(0, key === "costumePrompt" ? MAX_COSTUME_LENGTH : MAX_TEXT_LENGTH);
    }
  }

  if (raw.referenceAssetIds !== undefined) {
    if (!Array.isArray(raw.referenceAssetIds)) {
      throw validationError("视觉档案 referenceAssetIds 必须为字符串数组");
    }
    const ids = raw.referenceAssetIds.filter((v): v is string => typeof v === "string" && v.trim() !== "");
    if (ids.length > 0) {
      profile.referenceAssetIds = ids.map((s) => s.trim());
    }
  }

  if (Object.keys(profile).length === 0) return undefined;
  return profile;
}

/** 校验并规范角色名称 */
export function validateCharacterName(name: unknown): string {
  if (typeof name !== "string") {
    throw validationError("角色名称必须为字符串");
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw validationError("角色名称不能为空");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw validationError(`角色名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 校验并规范角色描述 */
export function validateCharacterDescription(description: unknown): string {
  if (typeof description !== "string") {
    throw validationError("角色描述必须为字符串");
  }
  const trimmed = description.trim();
  if (trimmed === "") {
    throw validationError("角色描述不能为空");
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw validationError(`角色描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 规范外观：白名单字段、字符串值、截断超长文本（输入允许任意结构，来自工具/AI 传入） */
export function normalizeAppearance(input?: unknown): CharacterAppearance {
  const appearance: CharacterAppearance = {};
  if (input === undefined) return appearance;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("角色外观必须为对象");
  }
  const raw = input as Partial<CharacterAppearance>;
  for (const key of APPEARANCE_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw validationError(`外观字段 ${key} 必须为字符串`);
    }
    const trimmed = value.trim();
    if (trimmed !== "") {
      appearance[key] = trimmed.slice(0, MAX_TEXT_LENGTH);
    }
  }
  return appearance;
}

/** 规范可选文本字段（personality 等） */
export function normalizeOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw validationError(`${field} 必须为字符串`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_TEXT_LENGTH);
}
