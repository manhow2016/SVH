/**
 * Content（内容）领域模型
 *
 * 对应技术文档第 40 条。Content 是 SVH 的第一等公民：
 * 一个 Project 下可以有多个 Content，每个 Content 代表一份具体内容
 * （一条广告、一期短视频、一集短剧、一条数字人口播……）。
 *
 * 设计原则：**不得把某一种内容类型的业务逻辑写死进核心模型**。
 * 类型差异通过 `type` + `metadata` + 绑定的 Workflow 表达。
 */
import { z } from 'zod';
import { CONTENT_STATUSES, CONTENT_TYPES, OUTPUT_TYPES } from './enums.js';
import {
  aspectRatioSchema,
  durationSecondsSchema,
  idSchema,
  platformSchema,
  slugSchema,
  storageRefSchema,
} from './common.js';

export const contentTypeSchema = z.enum(CONTENT_TYPES);
export const contentStatusSchema = z.enum(CONTENT_STATUSES);
export const outputTypeSchema = z.enum(OUTPUT_TYPES);

/**
 * Content 的类型化元数据。
 *
 * 这里只放**跨类型通用**的创作参数；类型特有的深层结构（如短剧的分集树、
 * 广告的产品卖点）应作为 Workflow 的产出物落在 ContentState / Canvas 上，
 * 而不是无限膨胀这张表。
 */
export const contentMetadataSchema = z
  .object({
    /** 目标时长（秒），如 30 秒广告 */
    duration: durationSecondsSchema.optional(),
    /** 画幅比例 */
    aspectRatio: aspectRatioSchema.optional(),
    /** 目标平台（抖音 / 小红书 / TikTok……），影响节奏、字幕、封面 */
    platform: platformSchema.optional(),
    /** 目标受众描述，如「年轻女性」 */
    audience: z.string().max(500).optional(),
    /** 风格关键词，如「高级、有质感、电影感」 */
    style: z.array(z.string().max(64)).max(20).optional(),
    /** 语言，如 zh-CN */
    language: z.string().max(32).optional(),
    /** 短剧集数 */
    episodes: z.number().int().min(1).max(500).optional(),
    /** 题材，如「古装复仇」 */
    genre: z.string().max(64).optional(),
    /** 关联的产品资产 Slug 列表（引用而非内嵌） */
    productSlugs: z.array(slugSchema).max(50).optional(),
    /** 关联的品牌资产 Slug */
    brandSlug: slugSchema.optional(),
    /** 关联的数字人资产 Slug */
    digitalHumanSlug: slugSchema.optional(),
    /** 自由扩展位，供 Agent 与业务插件使用 */
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ContentMetadata = z.infer<typeof contentMetadataSchema>;

/** 创建 Content */
export const createContentSchema = z.object({
  projectId: idSchema,
  type: contentTypeSchema,
  title: z.string().min(1, '标题不能为空').max(200),
  brief: z.string().max(5000).default(''),
  metadata: contentMetadataSchema.default({}),
  /** 可显式指定 Workflow；留空则由 Agent 规划 */
  workflowId: idSchema.optional(),
});

export type CreateContentInput = z.input<typeof createContentSchema>;

/** 更新 Content（全部字段可选） */
export const updateContentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  brief: z.string().max(5000).optional(),
  metadata: contentMetadataSchema.partial().optional(),
  status: contentStatusSchema.optional(),
  workflowId: idSchema.nullable().optional(),
});

export type UpdateContentInput = z.infer<typeof updateContentSchema>;

/** 动态导航分区：左侧导航必须按内容类型动态生成（文档第 58 条） */
export interface ContentSection {
  key: string;
  label: string;
  /** 该分区对应的领域概念，前端据此选择渲染器 */
  kind: 'script' | 'creative' | 'character' | 'scene' | 'episode' | 'storyboard' | 'shot' | 'visual' | 'video' | 'audio' | 'subtitle' | 'output' | 'copy' | 'voice';
}

/**
 * 各内容类型的导航分区配置。
 * 这是**声明式配置**，不是散落的 `if (contentType === 'drama')` 分支。
 */
export const CONTENT_SECTIONS: Record<z.infer<typeof contentTypeSchema>, ContentSection[]> = {
  short_video: [
    { key: 'topic', label: '选题', kind: 'creative' },
    { key: 'script', label: '脚本', kind: 'script' },
    { key: 'shots', label: '镜头', kind: 'shot' },
    { key: 'video', label: '视频', kind: 'video' },
    { key: 'subtitle', label: '字幕', kind: 'subtitle' },
    { key: 'output', label: '成片', kind: 'output' },
  ],
  advertisement: [
    { key: 'idea', label: '创意', kind: 'creative' },
    { key: 'product', label: '产品', kind: 'visual' },
    { key: 'script', label: '脚本', kind: 'script' },
    { key: 'storyboard', label: '分镜', kind: 'storyboard' },
    { key: 'video', label: '视频', kind: 'video' },
    { key: 'output', label: '成片', kind: 'output' },
  ],
  short_drama: [
    { key: 'script', label: '剧本', kind: 'script' },
    { key: 'characters', label: '角色', kind: 'character' },
    { key: 'scenes', label: '场景', kind: 'scene' },
    { key: 'episodes', label: '分集', kind: 'episode' },
    { key: 'storyboard', label: '分镜', kind: 'storyboard' },
    { key: 'video', label: '视频', kind: 'video' },
  ],
  digital_human: [
    { key: 'digitalHuman', label: '数字人', kind: 'character' },
    { key: 'copy', label: '文案', kind: 'copy' },
    { key: 'voice', label: '声音', kind: 'voice' },
    { key: 'video', label: '视频', kind: 'video' },
    { key: 'output', label: '成片', kind: 'output' },
  ],
  promo: [
    { key: 'outline', label: '大纲', kind: 'creative' },
    { key: 'script', label: '解说词', kind: 'script' },
    { key: 'shots', label: '镜头', kind: 'shot' },
    { key: 'video', label: '视频', kind: 'video' },
    { key: 'output', label: '成片', kind: 'output' },
  ],
  visual_content: [
    { key: 'concept', label: '创意', kind: 'creative' },
    { key: 'visuals', label: '视觉', kind: 'visual' },
    { key: 'output', label: '成品', kind: 'output' },
  ],
};

/** 获取某内容类型的导航分区 */
export function getContentSections(type: z.infer<typeof contentTypeSchema>): ContentSection[] {
  return CONTENT_SECTIONS[type];
}

/** Content 的对外输出物 */
export const createOutputSchema = z.object({
  contentId: idSchema,
  name: z.string().min(1).max(200),
  type: outputTypeSchema,
  /** 关联资产（成片视频、封面图等） */
  assetId: idSchema.optional(),
  storage: storageRefSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type CreateOutputInput = z.infer<typeof createOutputSchema>;
