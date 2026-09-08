/**
 * Character Consistency 模块（V0.3 Phase 3）。
 *
 * 提供角色一致性相关能力：
 * - `deriveCharacterPromptAnchor`：从外观/视觉档案派生稳定 Prompt Anchor；
 * - `ReferenceResolver`：角色 → 参考资产 → Provider 能力判定（回退 Anchor）。
 */
export * from "../character/character-anchor";
export * from "./reference-resolver";
export * from "./character-to-prompt";
