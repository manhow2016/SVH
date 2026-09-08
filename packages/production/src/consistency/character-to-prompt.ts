/**
 * Character → Prompt Snippet 桥接（V0.3 Phase 3）。
 *
 * 把角色实体映射为 Prompt Composer 使用的 CharacterPromptSnippet，
 * 其中 anchor 即 `deriveCharacterPromptAnchor` 派生的稳定 Prompt Anchor，
 * 保证同一角色跨镜头生成一致。
 */
import type { Character } from "../character/character-types";
import { deriveCharacterPromptAnchor } from "../character/character-anchor";
import type { CharacterPromptSnippet } from "../prompt/prompt-types";

export function toCharacterPromptSnippets(characters: Character[]): CharacterPromptSnippet[] {
  return characters.map((c) => ({
    name: c.name,
    anchor: deriveCharacterPromptAnchor(c) || undefined,
    visualPrompt: c.visualProfile?.appearancePrompt,
    description: c.description,
  }));
}
