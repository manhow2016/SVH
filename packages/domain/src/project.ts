/**
 * Project（项目）与 Project Memory 领域模型
 *
 * 对应技术文档第 38、50 条。
 * Project 是**长期创作项目**的容器，一个项目下包含多个 Content，
 * 它们共享 Brand / Product / Assets / Project Memory —— 这是 SVH 相比
 * 单一 AI 视频工具的核心差异。
 */
import { z } from 'zod';
import { CONTENT_TYPES, PROJECT_ROLES, PLAN_TIERS } from './enums.js';
import { idSchema, slugSchema, storageRefSchema } from './common.js';
import { appearanceSchema } from './asset.js';

export const projectRoleSchema = z.enum(PROJECT_ROLES);
export const planTierSchema = z.enum(PLAN_TIERS);

/**
 * 项目目标：Agent 每次规划前的顶层约束。
 */
export const projectGoalsSchema = z
  .object({
    /** 项目要达成的商业 / 创作目标 */
    objective: z.string().max(2000).optional(),
    /** 关键结果 */
    keyResults: z.array(z.string().max(500)).max(20).optional(),
    /** 主推内容类型 */
    primaryContentTypes: z.array(z.enum(CONTENT_TYPES)).max(10).optional(),
    /** 主要投放平台 */
    platforms: z.array(z.string().max(32)).max(20).optional(),
  })
  .strict();

/**
 * 品牌规范在项目层的快照。
 * Agent 生成任何素材前都会读取该结构，保证跨 Content 的视觉一致性。
 */
export const projectBrandRulesSchema = z
  .object({
    /** 品牌资产引用 */
    brandAssetId: idSchema.optional(),
    /** 主色 / 辅色 */
    colors: z.array(z.string().max(32)).max(20).optional(),
    /** 字体 */
    fonts: z.array(z.string().max(128)).max(20).optional(),
    /** 语气调性，如「专业、克制、有科技感」 */
    tone: z.string().max(500).optional(),
    /** 必须遵守 */
    must: z.array(z.string().max(300)).max(30).optional(),
    /** 禁止出现 */
    forbidden: z.array(z.string().max(300)).max(30).optional(),
    /** Logo 使用规范 */
    logoRules: z.string().max(1000).optional(),
  })
  .strict();

/** 视觉规范：跨内容统一的画面风格 */
export const projectVisualRulesSchema = z
  .object({
    /** 整体风格，如「电影感、高级、冷调」 */
    style: z.string().max(1000).optional(),
    /** 风格关键词 */
    styleKeywords: z.array(z.string().max(64)).max(30).optional(),
    /** 默认画幅 */
    defaultAspectRatio: z.string().max(16).optional(),
    /** 色彩倾向 */
    colorGrading: z.string().max(500).optional(),
    /** 镜头语言偏好 */
    cameraLanguage: z.string().max(500).optional(),
    /** 负面提示词（全局） */
    negativePrompt: z.string().max(2000).optional(),
    /** 风格参考图 */
    styleReferences: z.array(storageRefSchema).max(20).optional(),
    /** 固定风格 LoRA / 模型标识 */
    styleModelId: z.string().max(128).optional(),
  })
  .strict();

/** 制作规则：流程层面的硬约束 */
export const projectProductionRulesSchema = z
  .object({
    /** 单个镜头默认时长（秒） */
    defaultShotDuration: z.number().positive().max(60).optional(),
    /** 单条内容默认时长 */
    defaultContentDuration: z.number().positive().max(3600).optional(),
    /** 默认字幕样式 */
    defaultSubtitleStyle: z.string().max(500).optional(),
    /** 是否强制人工确认高成本任务 */
    requireConfirmationForHighCost: z.boolean().optional(),
    /** 高成本阈值（估算调用次数） */
    highCostThreshold: z.number().int().positive().max(100000).optional(),
    /** 默认配音音色资产 id */
    defaultVoiceAssetId: idSchema.optional(),
    /** 默认背景音乐资产 id */
    defaultMusicAssetId: idSchema.optional(),
  })
  .strict();

/** 用户偏好：Agent 应记住的个人化设置 */
export const projectUserPreferencesSchema = z
  .object({
    /** 语言 */
    language: z.string().max(32).optional(),
    /** 输出详细程度：简洁 / 标准 / 详尽 */
    verbosity: z.enum(['concise', 'standard', 'detailed']).optional(),
    /** 用户偏好风格备注 */
    notes: z.string().max(2000).optional(),
    /** 常用平台 */
    preferredPlatforms: z.array(z.string().max(32)).max(20).optional(),
  })
  .strict();

/**
 * Project Memory —— 结构化项目记忆。
 *
 * Agent **不允许**每次读取整个项目（文档第 50/51 条）：
 * 它读取的是这份精炼后的记忆，再由 Context Resolver 按任务装配上下文。
 */
export const projectMemorySchema = z
  .object({
    /** 项目目标 */
    goals: projectGoalsSchema.default({}),
    /** 品牌规范 */
    brand: projectBrandRulesSchema.default({}),
    /** 视觉规范 */
    visual: projectVisualRulesSchema.default({}),
    /** 制作规则 */
    production: projectProductionRulesSchema.default({}),
    /** 用户偏好 */
    preferences: projectUserPreferencesSchema.default({}),
    /** 世界观设定（短剧 / 宣传片常用） */
    worldview: z.string().max(20000).optional(),
    /** 主要角色外观锚点：slug → 外观，用于角色一致性快速装配 */
    characterAnchors: z.record(slugSchema, appearanceSchema).optional(),
    /** 补充说明 */
    notes: z.string().max(5000).optional(),
  })
  .strict();

export type ProjectMemory = z.infer<typeof projectMemorySchema>;

/** 创建项目 */
export const createProjectSchema = z.object({
  name: z.string().min(1, '项目名称不能为空').max(200),
  description: z.string().max(5000).default(''),
  /** 项目记忆初值 */
  memory: projectMemorySchema.partial().optional(),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;

/** 更新项目 */
export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  memory: projectMemorySchema.partial().optional(),
  archived: z.boolean().optional(),
});

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/** 项目成员 */
export const addProjectMemberSchema = z.object({
  projectId: idSchema,
  userId: idSchema,
  role: projectRoleSchema.default('editor'),
});

/** 项目概览统计（首页 / 项目页展示用） */
export interface ProjectOverview {
  projectId: string;
  contentCount: number;
  assetCount: number;
  /** 各状态内容数量 */
  contentsByStatus: Record<string, number>;
  /** 各类型内容数量 */
  contentsByType: Record<string, number>;
  updatedAt: string;
}
