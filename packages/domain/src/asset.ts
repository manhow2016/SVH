/**
 * Asset（资产）领域模型
 *
 * 对应技术文档第 14~18 条。SVH 使用**统一资产系统**：
 * 角色 / 产品 / 品牌 / 场景 / 数字人 / 图片 / 视频 / 音频……共用一张表，
 * 通过 `type` 区分，类型特有的结构放在经过校验的 `metadata` 中。
 *
 * 两条硬性要求：
 * 1. **跨 Content 复用** —— 同一品牌资产可被广告、短视频、数字人同时引用。
 * 2. **必须支持版本** —— 每个资产都有 asset_versions 历史，可查看 / 对比 / 恢复。
 */
import { z } from 'zod';
import {
  ASSET_STATUSES,
  ASSET_TYPES,
  CREATIVE_ASSET_TYPES,
  MEDIA_ASSET_TYPES,
  type AssetType,
} from './enums.js';
import { idSchema, slugSchema, storageRefSchema } from './common.js';

export const assetTypeSchema = z.enum(ASSET_TYPES);
export const assetStatusSchema = z.enum(ASSET_STATUSES);

/* -------------------------------------------------------------------------- */
/* 子结构                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 外观描述：角色一致性的关键。
 * Agent 在重新生成镜头时会读取该结构，保证「脸 / 发型 / 年龄 / 身材」不被改动。
 */
export const appearanceSchema = z
  .object({
    /** 性别气质 */
    gender: z.enum(['male', 'female', 'other', 'unspecified']).optional(),
    age: z.number().int().min(0).max(200).optional(),
    ageRange: z.string().max(32).optional(),
    /** 面部特征，如「鹅蛋脸、丹凤眼」 */
    facialFeatures: z.string().max(500).optional(),
    /** 发型发色，如「黑色长直发」 */
    hair: z.string().max(200).optional(),
    /** 瞳色 */
    eyeColor: z.string().max(64).optional(),
    /** 身材体型，如「纤细高挑」 */
    bodyType: z.string().max(200).optional(),
    /** 身高（厘米） */
    heightCm: z.number().int().min(50).max(300).optional(),
    /** 辨识特征，如「左眉尾有一道浅疤」 */
    distinguishingFeatures: z.array(z.string().max(200)).max(20).optional(),
    /** 服装描述，如「月白色齐胸襦裙」 */
    costume: z.string().max(500).optional(),
    /** 配饰 */
    accessories: z.array(z.string().max(200)).max(20).optional(),
    /** 整体气质，如「清冷疏离」 */
    vibe: z.string().max(200).optional(),
  })
  .strict();

export type Appearance = z.infer<typeof appearanceSchema>;

/** 品牌视觉规范：Agent 生成任何素材前都要读取 */
export const brandGuidelinesSchema = z
  .object({
    /** 必须遵守的规则 */
    must: z.array(z.string().max(300)).max(30).optional(),
    /** 禁止出现的元素 */
    forbidden: z.array(z.string().max(300)).max(30).optional(),
    /** 视觉风格描述 */
    visualStyle: z.string().max(500).optional(),
    /** 字体层级约定 */
    typography: z.record(z.string(), z.string()).optional(),
    /** 版式留白规则 */
    spacing: z.string().max(300).optional(),
    /** 版权 / 合规说明 */
    compliance: z.string().max(1000).optional(),
  })
  .strict();

/** 角色结构化外观描述（中文键名，直接供 Prompt Compiler 使用） */
const appearanceFieldsShape = {
  /** 性别 */
  性别: z.string().max(32).optional(),
  /** 年龄 */
  年龄: z.union([z.number().int().min(0).max(200), z.string().max(32)]).optional(),
  /** 发型 */
  发型: z.string().max(200).optional(),
  /** 发色 */
  发色: z.string().max(64).optional(),
  /** 服装 */
  服装: z.string().max(500).optional(),
  /** 体型 */
  体型: z.string().max(200).optional(),
  /** 气质 */
  气质: z.string().max(200).optional(),
  /** 特征 */
  特征: z.string().max(500).optional(),
};

/** 通用「带 description 的条目」结构，用于世界观 / 场景列表等 */
const describedItemSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
});

/* -------------------------------------------------------------------------- */
/* 各资产类型的 metadata                                                       */
/* -------------------------------------------------------------------------- */

/** 角色（文档第 15 条） */
export const characterMetadataSchema = z
  .object({
    /** 结构化外观 */
    appearance: appearanceSchema.optional(),
    /** 中文键名外观，便于直接拼 Prompt */
    appearanceFields: z.object(appearanceFieldsShape).strict().optional(),
    /** 服装 / 造型方案 */
    costume: z
      .object({
        name: z.string().max(200).optional(),
        description: z.string().max(1000).optional(),
        colors: z.array(z.string().max(32)).max(20).optional(),
      })
      .strict()
      .optional(),
    /** 性格与人物小传 */
    personality: z.string().max(2000).optional(),
    /** 背景故事 */
    backstory: z.string().max(5000).optional(),
    /** 在剧情中的定位，如「女主」「反派」 */
    role: z.string().max(128).optional(),
    /** 首次出场分集 */
    firstAppearance: z.string().max(64).optional(),
    /** 参考图（用于角色一致性） */
    reference_images: z.array(storageRefSchema).max(30).optional(),
  })
  .strict();

/** 数字人（文档第 18 条） */
export const digitalHumanMetadataSchema = z
  .object({
    gender: z.enum(['male', 'female', 'other', 'unspecified']).optional(),
    appearance: appearanceSchema.optional(),
    /** 音色配置：voice 资产引用 + 语速音调 */
    voice: z
      .object({
        /** 引用 voice 类型资产的 id */
        voiceAssetId: idSchema.optional(),
        /** 语速，1.0 为正常 */
        speed: z.number().min(0.5).max(2).optional(),
        /** 音调 */
        pitch: z.number().min(0.5).max(2).optional(),
        /** 音量 */
        volume: z.number().min(0).max(2).optional(),
        /** 情绪，如「亲切」「专业」 */
        emotion: z.string().max(64).optional(),
        /** 语言 */
        language: z.string().max(32).optional(),
      })
      .strict()
      .optional(),
    /** 动作 / 驱动配置 */
    motion: z
      .object({
        /** 驱动方式：口播 / 全身动作 / 手势 */
        mode: z.enum(['talking_head', 'half_body', 'full_body']).optional(),
        /** 动作模板标识 */
        template: z.string().max(128).optional(),
        /** 默认背景资产引用 */
        backgroundAssetId: idSchema.optional(),
      })
      .strict()
      .optional(),
    /** 驱动所需参考素材 */
    reference: z.array(storageRefSchema).max(30).optional(),
    /** 底模 / 驱动服务标识（由 Model Router 解释） */
    driverModel: z.string().max(128).optional(),
  })
  .strict();

/** 产品（文档第 16 条） */
export const productMetadataSchema = z
  .object({
    /** 卖点列表 */
    sellingPoints: z.array(z.string().max(300)).max(30).optional(),
    /** 规格参数 */
    specs: z.record(z.string(), z.string()).optional(),
    /** 品类，如「护肤品 / 精华」 */
    category: z.string().max(128).optional(),
    /** 价格展示文案 */
    price: z.string().max(64).optional(),
    /** 目标人群 */
    targetAudience: z.string().max(500).optional(),
    /** 使用场景 */
    usageScenarios: z.array(z.string().max(200)).max(20).optional(),
    /** 关联品牌资产 id */
    brandId: idSchema.optional(),
    /** 官方视觉规范补充 */
    visualNotes: z.string().max(2000).optional(),
  })
  .strict();

/** 品牌（文档第 17 条） */
export const brandMetadataSchema = z
  .object({
    /** 品牌色（HEX） */
    colors: z.array(z.string().max(32)).max(20).optional(),
    /** 字体族 */
    fonts: z.array(z.string().max(128)).max(20).optional(),
    /** 品牌调性 */
    tone: z.string().max(500).optional(),
    /** 品牌口号 */
    slogan: z.string().max(300).optional(),
    /** 品牌规范 */
    guidelines: brandGuidelinesSchema.optional(),
    /** 行业 */
    industry: z.string().max(128).optional(),
    /** 品牌故事 */
    story: z.string().max(5000).optional(),
    /** Logo 资产引用 */
    logoAssetId: idSchema.optional(),
  })
  .strict();

/** 场景（文档第 14 条，短剧 / 广告共用） */
export const sceneMetadataSchema = z
  .object({
    /** 时间，如「夜」「黄昏」 */
    timeOfDay: z.string().max(64).optional(),
    /** 光照，如「月光」「暖色台灯」 */
    lighting: z.string().max(128).optional(),
    /** 天气 */
    weather: z.string().max(64).optional(),
    /** 地点，如「长安城朱雀大街」 */
    location: z.string().max(200).optional(),
    /** 时代背景 */
    era: z.string().max(128).optional(),
    /** 空间氛围 */
    atmosphere: z.string().max(500).optional(),
    /** 空间元素清单 */
    elements: z.array(describedItemSchema).max(50).optional(),
    /** 主色调 */
    colorPalette: z.array(z.string().max(32)).max(20).optional(),
    /** 镜头运动建议，如「缓慢推近」 */
    cameraNotes: z.string().max(500).optional(),
    /** 该场景下的默认音效 */
    ambientSound: z.string().max(200).optional(),
  })
  .strict();

/** 道具 */
export const propMetadataSchema = z
  .object({
    category: z.string().max(128).optional(),
    material: z.string().max(128).optional(),
    appearance: z.string().max(1000).optional(),
    /** 剧情意义 */
    storyMeaning: z.string().max(1000).optional(),
    ownerCharacterId: idSchema.optional(),
  })
  .strict();

/** 服装 */
export const costumeMetadataSchema = z
  .object({
    category: z.string().max(128).optional(),
    /** 主色，如「中国红」 */
    primaryColor: z.string().max(64).optional(),
    colors: z.array(z.string().max(32)).max(20).optional(),
    material: z.string().max(128).optional(),
    era: z.string().max(128).optional(),
    /** 适用角色 */
    forCharacterIds: z.array(idSchema).max(50).optional(),
    /** 穿着场合 */
    occasion: z.string().max(200).optional(),
  })
  .strict();

/** 素材类资产的通用 metadata（图片 / 视频 / 音频 / 音乐 / 字体 / Logo） */
export const mediaMetadataSchema = z
  .object({
    width: z.number().int().positive().max(20000).optional(),
    height: z.number().int().positive().max(20000).optional(),
    /** 时长（秒），音视频 */
    duration: z.number().positive().max(60 * 60 * 8).optional(),
    format: z.string().max(32).optional(),
    fps: z.number().positive().max(240).optional(),
    /** 采样率 */
    sampleRate: z.number().int().positive().max(384000).optional(),
    /** 声道数 */
    channels: z.number().int().min(1).max(16).optional(),
    /** 语言（音色 / 字幕） */
    language: z.string().max(32).optional(),
    /** 歌词 / 文本内容 */
    transcript: z.string().max(20000).optional(),
    /** 生成该素材所用的模型与提示词快照 */
    generation: z
      .object({
        modelId: idSchema.optional(),
        prompt: z.string().max(10000).optional(),
        negativePrompt: z.string().max(10000).optional(),
        seed: z.number().int().optional(),
        steps: z.number().int().positive().max(500).optional(),
        guidance: z.number().min(0).max(50).optional(),
        /** 生成所依据的 Skill 与任务 */
        skillId: z.string().max(128).optional(),
        taskId: idSchema.optional(),
      })
      .strict()
      .optional(),
    /** 音色属性（voice 类型） */
    voiceTraits: z
      .object({
        gender: z.enum(['male', 'female', 'other', 'unspecified']).optional(),
        ageRange: z.string().max(32).optional(),
        timbre: z.string().max(128).optional(),
        style: z.string().max(128).optional(),
        accent: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* 判别联合 + 解析器                                                           */
/* -------------------------------------------------------------------------- */

/** 无特定结构的资产类型使用宽松的通用 metadata */
const genericMetadataSchema = mediaMetadataSchema;

/**
 * 资产判别联合 Schema。
 * 通过 `type` 字段收窄 `metadata` 的类型，使 `resolveAssetMetadata` 能返回精确类型。
 */
export const assetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('character'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: characterMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('digital_human'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: digitalHumanMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('product'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: productMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('brand'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: brandMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('scene'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: sceneMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('prop'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: propMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('costume'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: costumeMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('image'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: genericMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('video'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: genericMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('audio'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: genericMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('voice'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: genericMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('music'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: genericMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('logo'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: genericMetadataSchema.default({}),
  }),
  z.object({
    type: z.literal('font'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    metadata: genericMetadataSchema.default({}),
  }),
]);

export type Asset = z.infer<typeof assetSchema>;

/**
 * 资产类型 → metadata 类型的映射表。
 *
 * 显式列出而不使用 `Extract<Asset, { type: T }>`：
 * 后者在泛型 `T` 下会退化成「所有分支 metadata 的交叉类型」，无法正确收窄。
 */
export interface AssetMetadataMap {
  character: z.infer<typeof characterMetadataSchema>;
  digital_human: z.infer<typeof digitalHumanMetadataSchema>;
  product: z.infer<typeof productMetadataSchema>;
  brand: z.infer<typeof brandMetadataSchema>;
  scene: z.infer<typeof sceneMetadataSchema>;
  prop: z.infer<typeof propMetadataSchema>;
  costume: z.infer<typeof costumeMetadataSchema>;
  image: z.infer<typeof genericMetadataSchema>;
  video: z.infer<typeof genericMetadataSchema>;
  audio: z.infer<typeof genericMetadataSchema>;
  voice: z.infer<typeof genericMetadataSchema>;
  music: z.infer<typeof genericMetadataSchema>;
  logo: z.infer<typeof genericMetadataSchema>;
  font: z.infer<typeof genericMetadataSchema>;
}

/** 按类型取 metadata 校验器 */
const METADATA_SCHEMAS: Record<AssetType, z.ZodTypeAny> = {
  character: characterMetadataSchema,
  digital_human: digitalHumanMetadataSchema,
  product: productMetadataSchema,
  brand: brandMetadataSchema,
  scene: sceneMetadataSchema,
  prop: propMetadataSchema,
  costume: costumeMetadataSchema,
  image: genericMetadataSchema,
  video: genericMetadataSchema,
  audio: genericMetadataSchema,
  voice: genericMetadataSchema,
  music: genericMetadataSchema,
  logo: genericMetadataSchema,
  font: genericMetadataSchema,
};

/**
 * 校验并收窄资产元数据。
 *
 * 用法：
 * ```ts
 * const meta = resolveAssetMetadata('character', input); // 返回 CharacterMetadata
 * ```
 * 传入未知 `type` 或结构不合法时抛出 ZodError。
 */
export function resolveAssetMetadata<T extends AssetType>(
  type: T,
  metadata: unknown,
): AssetMetadataMap[T] {
  const schema = METADATA_SCHEMAS[type];
  return schema.parse(metadata ?? {}) as AssetMetadataMap[T];
}

/** 判断是否为创意实体类资产 */
export function isCreativeAsset(type: AssetType): boolean {
  return (CREATIVE_ASSET_TYPES as readonly string[]).includes(type);
}

/** 判断是否为素材（文件）类资产 */
export function isMediaAsset(type: AssetType): boolean {
  return (MEDIA_ASSET_TYPES as readonly string[]).includes(type);
}

/* -------------------------------------------------------------------------- */
/* 创建 / 更新请求                                                             */
/* -------------------------------------------------------------------------- */

/** 创建资产请求 */
export const createAssetSchema = z.object({
  projectId: idSchema,
  type: assetTypeSchema,
  name: z.string().min(1, '资产名称不能为空').max(200),
  /** 用户可通过 @引用名 引用该资产；留空则由服务端按 name 生成 */
  slug: slugSchema.optional(),
  description: z.string().max(2000).default(''),
  /** 类型化元数据，由 resolveAssetMetadata 二次校验 */
  metadata: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().max(64)).max(50).default([]),
  files: z.array(storageRefSchema).max(50).default([]),
  /** 封面图 URL，用于卡片预览 */
  coverUrl: z.string().max(2000).optional(),
  /** 来源内容（由哪条内容生成） */
  sourceContentId: idSchema.optional(),
});

export type CreateAssetInput = z.infer<typeof createAssetSchema>;

/** 更新资产请求（部分字段） */
export const updateAssetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: slugSchema.optional(),
  description: z.string().max(2000).optional(),
  /** 部分更新：与现有 metadata 深合并后再整体校验 */
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  files: z.array(storageRefSchema).max(50).optional(),
  coverUrl: z.string().max(2000).nullable().optional(),
  status: assetStatusSchema.optional(),
});

export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

/** 资产版本快照内容 */
export const assetSnapshotSchema = z.object({
  name: z.string(),
  description: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  files: z.array(storageRefSchema),
  coverUrl: z.string().nullable().optional(),
  status: assetStatusSchema,
});

export type AssetSnapshot = z.infer<typeof assetSnapshotSchema>;

/** 资产被引用记录（用于「修改角色是否需要同步更新 12 个镜头」的判断） */
export interface AssetReferenceInfo {
  id: string;
  assetId: string;
  /** 引用方：content / workflow_run / task / output */
  refType: 'content' | 'workflow_run' | 'task' | 'output' | 'canvas_node';
  refId: string;
  /** 引用路径，如 scene.03.shot.02 */
  refPath?: string | null;
  contentId?: string | null;
}

/** 深合并工具：用于 patch 语义的 metadata 更新 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = result[key];
    if (value === null) {
      // null 表示显式清除该字段
      delete result[key];
      continue;
    }
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof prev === 'object' &&
      prev !== null &&
      !Array.isArray(prev)
    ) {
      result[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
