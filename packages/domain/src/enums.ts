/**
 * SVH 领域枚举 —— 单一事实来源（Single Source of Truth）
 *
 * 设计要点：
 * 1. 每个枚举先声明为 `as const` 的字符串数组，再派生 TypeScript 联合类型。
 * 2. Prisma schema 通过 `import` 直接引用这些数组，因此**数据库枚举与领域类型永远不会漂移**。
 * 3. Zod 在 `schemas.ts` 中基于同一数组构建，保证运行时校验与编译期类型一致。
 *
 * 新增枚举值只需改动本文件一处。
 */

/** 内容类型：用户无需主动选择，由 Agent 自动识别 */
export const CONTENT_TYPES = [
  'short_video',
  'advertisement',
  'short_drama',
  'digital_human',
  'promo',
  'visual_content',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** 内容状态机：draft → planning → processing → review → completed */
export const CONTENT_STATUSES = [
  'draft',
  'planning',
  'processing',
  'review',
  'completed',
  'failed',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** 内容类型的中文展示名 */
export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  short_video: '短视频',
  advertisement: '广告',
  short_drama: '短剧',
  digital_human: '数字人',
  promo: '宣传片',
  visual_content: '视觉内容',
};

/** 资产类型：统一 Asset System，跨 Content 复用 */
export const ASSET_TYPES = [
  // 创意实体类
  'character',
  'digital_human',
  'product',
  'brand',
  'scene',
  'prop',
  'costume',
  // 素材类
  'image',
  'video',
  'audio',
  'voice',
  'music',
  'logo',
  'font',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** 资产类型的中文展示名 */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  character: '角色',
  digital_human: '数字人',
  product: '产品',
  brand: '品牌',
  scene: '场景',
  prop: '道具',
  costume: '服装',
  image: '图片',
  video: '视频',
  audio: '音频',
  voice: '音色',
  music: '音乐',
  logo: '标识',
  font: '字体',
};

/** 创意实体类资产（可被内容引用、可生成、通常不是文件） */
export const CREATIVE_ASSET_TYPES = [
  'character',
  'digital_human',
  'product',
  'brand',
  'scene',
  'prop',
  'costume',
] as const satisfies readonly AssetType[];

/** 素材类资产（通常对应一个已落盘的文件） */
export const MEDIA_ASSET_TYPES = [
  'image',
  'video',
  'audio',
  'voice',
  'music',
  'logo',
  'font',
] as const satisfies readonly AssetType[];

/** 资产状态 */
export const ASSET_STATUSES = ['active', 'draft', 'archived'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** 任务状态：低风险任务自动执行，高风险任务进入 waiting_user 等待确认 */
export const TASK_STATUSES = [
  'pending',
  'running',
  'waiting_user',
  'success',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 任务风险等级：决定 Agent 是否需要先征求用户确认（文档第 47 条） */
export const TASK_RISKS = ['low', 'medium', 'high'] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

/** Agent 状态机（文档第 46 条） */
export const AGENT_STATES = [
  'idle',
  'thinking',
  'planning',
  'executing',
  'waiting_user',
  'completed',
  'failed',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Skill 执行状态 */
export const EXECUTION_STATUSES = [
  'pending',
  'running',
  'success',
  'failed',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Workflow 运行状态 */
export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** 会话状态 */
export const SESSION_STATUSES = ['active', 'archived'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** 消息角色 */
export const MESSAGE_ROLES = ['user', 'agent', 'system', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** 消息结构类型（对应文档第 55/56 条的 Agent Response Protocol / Plan Protocol） */
export const MESSAGE_KINDS = [
  'text',
  'plan',
  'result_card',
  'confirmation_request',
  'progress',
  'error',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** 信息流方向 */
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** 项目成员角色 */
export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** 输出类型（文档第 63 条） */
export const OUTPUT_TYPES = [
  'image',
  'video',
  'audio',
  'subtitle',
  'project',
  'text',
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

/** Skill 访问等级：Agent 执行前必须做权限检查（文档第 68 条） */
export const SKILL_ACCESS_TIERS = ['free', 'pro', 'enterprise'] as const;
export type SkillAccessTier = (typeof SKILL_ACCESS_TIERS)[number];

/** 会员套餐档位（与模型 API 费用解耦，文档第 69 条） */
export const PLAN_TIERS = ['free', 'professional', 'enterprise'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/** 模型 Provider 类型：支持用户自带 API（文档第 30 条） */
export const MODEL_PROVIDER_KINDS = [
  'openai_compatible',
  'anthropic_compatible',
  'gemini_compatible',
  'custom',
] as const;
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

/** 模型能力标签：Model Router 据此为 Skill 挑选候选模型 */
export const MODEL_CAPABILITIES = [
  'text',
  'script',
  'image',
  'image_edit',
  'video',
  'video_extend',
  'audio',
  'voice',
  'music',
  'digital_human',
  'subtitle',
  'embedding',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** 模型能力的中文展示名 */
export const MODEL_CAPABILITY_LABELS: Record<ModelCapability, string> = {
  text: '文本',
  script: '剧本',
  image: '图片',
  image_edit: '图片编辑',
  video: '视频',
  video_extend: '视频延长',
  audio: '音频',
  voice: '配音',
  music: '音乐',
  digital_human: '数字人',
  subtitle: '字幕',
  embedding: '向量',
};

/** 模型任务状态 */
export const MODEL_TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type ModelTaskStatus = (typeof MODEL_TASK_STATUSES)[number];

/** Workflow 定义来源：内置 / Agent 动态规划 / 用户自定义 */
export const WORKFLOW_ORIGINS = ['builtin', 'agent_planned', 'user'] as const;
export type WorkflowOrigin = (typeof WORKFLOW_ORIGINS)[number];

/** 支持的目标平台（文档第 62 条） */
export const PLATFORMS = [
  'douyin',
  'xiaohongshu',
  'kuaishou',
  'wechat_channels',
  'youtube',
  'youtube_shorts',
  'instagram',
  'tiktok',
  'bilibili',
  'generic',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** 平台中文展示名 */
export const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  wechat_channels: '视频号',
  youtube: 'YouTube',
  youtube_shorts: 'YouTube Shorts',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  bilibili: '哔哩哔哩',
  generic: '通用',
};

/** 画幅比例 */
export const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
