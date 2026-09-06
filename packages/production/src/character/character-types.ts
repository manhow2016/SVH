/**
 * Character 类型（文档 §6.3）。
 */
export interface CharacterAppearance {
  gender?: string;
  age?: string;
  hairstyle?: string;
  clothing?: string;
  facialFeatures?: string;
  style?: string;
}

export interface Character {
  id: string;
  projectId: string;
  name: string;
  description: string;
  appearance: CharacterAppearance;
  personality?: string;
  /** 角色参考图资产（production_assets.id） */
  referenceAssetId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入 */
export interface CreateCharacterInput {
  projectId: string;
  name: string;
  description: string;
  appearance?: Partial<CharacterAppearance>;
  personality?: string;
  referenceAssetId?: string;
}

/** 更新输入 */
export type UpdateCharacterInput = Partial<
  Pick<Character, "name" | "description" | "appearance" | "personality" | "referenceAssetId">
>;
