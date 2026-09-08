/**
 * Character Prompt Anchor（V0.3 Phase 3，实施文档 §21）。
 *
 * Prompt Anchor 是从角色外观 + 视觉档案派生出的「稳定描述段」，
 * 用于让同一角色在多个镜头生成中使用一致的形象描述。
 *
 * 派生规则：确定性（同一角色 → 同一 Anchor），顺序固定：
 * AppearancePrompt（无则由结构化 appearance 组装）→ IdentityPrompt
 * → CostumePrompt → StylePrompt。
 */
import type { Character } from "./character-types";
import { normalizeAppearance } from "./character";

/** 文本拼接用常量（保证确定性，不受 locale 影响） */
function append(parts: string[], value: string | undefined): void {
  const v = value?.trim();
  if (v) parts.push(v);
}

/** 由结构化外观组装描述（无显式 appearancePrompt 时兜底） */
function assembleAppearanceText(appearance: Character["appearance"]): string | undefined {
  const norm = normalizeAppearance(appearance);
  const parts: string[] = [];
  if (norm.gender) parts.push(`gender ${norm.gender}`);
  if (norm.age) parts.push(`age ${norm.age}`);
  if (norm.hairstyle) parts.push(`hairstyle ${norm.hairstyle}`);
  if (norm.clothing) parts.push(`wearing ${norm.clothing}`);
  if (norm.facialFeatures) parts.push(`face ${norm.facialFeatures}`);
  if (norm.style) parts.push(`style ${norm.style}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * 派生角色的 Prompt Anchor（稳定、确定性）。
 * 推荐直接作为 `CharacterPromptSnippet.anchor` 注入 Prompt Composer，
 * 以实现同一角色跨镜头一致。
 */
export function deriveCharacterPromptAnchor(character: Character): string {
  const vp = character.visualProfile;
  const parts: string[] = [];
  // 优先显式外观 Prompt；否则由结构化 appearance 兜底组装
  append(parts, vp?.appearancePrompt ?? assembleAppearanceText(character.appearance));
  append(parts, vp?.identityPrompt);
  append(parts, vp?.costumePrompt);
  append(parts, vp?.stylePrompt);
  return parts.join(", ");
}
