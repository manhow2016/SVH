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

/**
 * Character 视觉档案（V0.3 Phase 3，实施文档 §20）。
 *
 * 用于保持角色在多镜头生成中的外观一致性：提供外观/身份/服装/风格 Prompt 段
 * 与参考图资产 id。配合 `deriveCharacterPromptAnchor` 生成稳定 Prompt Anchor。
 */
export interface CharacterVisualProfile {
  /** 外观 Prompt（角色长什么样） */
  appearancePrompt?: string;
  /** 身份/气质 Prompt */
  identityPrompt?: string;
  /** 服装 Prompt */
  costumePrompt?: string;
  /** 专属风格 Prompt */
  stylePrompt?: string;
  /** 负面 Prompt */
  negativePrompt?: string;
  /** 参考图资产 id（production_assets.id） */
  referenceAssetIds?: string[];
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
  /** V0.3 Phase 3：角色视觉档案（一致性用） */
  visualProfile?: CharacterVisualProfile;
  /** Phase C：配音音色（TTS 模型支持的 voice 名；缺省供应商默认） */
  voice?: string;
  /** 角色面板：配音音色资产引用（项目 audio 资产 id；空 = 未设置） */
  voiceAssetId?: string;
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
  visualProfile?: CharacterVisualProfile;
  voice?: string;
}

/** 更新输入 */
export type UpdateCharacterInput = Partial<
  Pick<
    Character,
    | "name"
    | "description"
    | "appearance"
    | "personality"
    | "referenceAssetId"
    | "visualProfile"
    | "voice"
  >
> & {
  /**
   * 配音音色资产引用：null / 空串 = 显式清空（与 updateAssetFields 的 null 清列语义一致），
   * undefined = 不动。领域输出（Character）统一为 `string | undefined`。
   */
  voiceAssetId?: string | null;
};
