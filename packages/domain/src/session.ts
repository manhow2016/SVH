/**
 * Session（会话）与 Message（消息）领域模型
 *
 * 对应技术文档第 38、55、56 条。
 * Session 代表**一次 Agent 工作过程**：创建广告、修改广告、重新生成视频，
 * 各是一次独立 Session，便于回溯「这次改动是怎么发生的」。
 *
 * 消息使用结构化协议而非纯文本：
 * - `plan`：制作计划（可渲染为带勾选项的清单）
 * - `result_card`：结构化操作卡片（角色已创建 / 视频已生成）
 * - `confirmation_request`：高风险任务确认
 */
import { z } from 'zod';
import { AGENT_STATES, MESSAGE_DIRECTIONS, MESSAGE_KINDS, MESSAGE_ROLES, SESSION_STATUSES } from './enums.js';
import { idSchema } from './common.js';

export const agentStateSchema = z.enum(AGENT_STATES);
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export const messageRoleSchema = z.enum(MESSAGE_ROLES);
export const messageKindSchema = z.enum(MESSAGE_KINDS);
export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);

/**
 * 上下文快照：本次 Session 实际装配了哪些上下文。
 * 用于调试 Context Resolver 的取舍，以及让用户理解「Agent 为什么这么改」。
 */
export const contextSnapshotSchema = z
  .object({
    /** 装配进来的资产 id */
    assetIds: z.array(idSchema).max(200).default([]),
    /** 装配进来的内容 id */
    contentIds: z.array(idSchema).max(50).default([]),
    /** 是否加载了项目记忆 */
    projectMemory: z.boolean().default(false),
    /** 是否加载了历史消息 */
    historyMessages: z.number().int().nonnegative().default(0),
    /** 估算的 token 数 */
    estimatedTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* 结构化消息体                                                                */
/* -------------------------------------------------------------------------- */

/** 计划中的单个任务项 */
export const planTaskSchema = z.object({
  id: z.string().min(1).max(64),
  /** 展示标题，如「生成分镜」 */
  title: z.string().min(1).max(200),
  /** 要执行的 Skill id，如 advertisement.storyboard */
  skill: z.string().max(128).optional(),
  /** 计划状态 */
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']).default('pending'),
  /** 该步骤对应的任务 id（执行后回填） */
  taskId: idSchema.optional(),
  /** 预估消耗说明，如「约 6 次图片生成」 */
  estimate: z.string().max(200).optional(),
  /** 依赖的前置步骤 id */
  dependsOn: z.array(z.string().max(64)).max(50).default([]),
});

export type PlanTask = z.infer<typeof planTaskSchema>;

/** Plan Protocol（文档第 56 条） */
export const planPayloadSchema = z.object({
  type: z.literal('plan'),
  /** 计划目标，如「制作 30 秒广告」 */
  goal: z.string().min(1).max(500),
  /** 一句话说明为什么这样规划 */
  rationale: z.string().max(2000).optional(),
  tasks: z.array(planTaskSchema).min(1).max(100),
  /** 是否需要用户点击「开始制作」 */
  requiresApproval: z.boolean().default(false),
});

export type PlanPayload = z.infer<typeof planPayloadSchema>;

/** 结果卡片中的一个操作按钮 */
export const cardActionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  /** 操作语义，前端据此决定是发消息还是直接调 API */
  kind: z.enum(['reply', 'primary', 'secondary', 'danger']).default('secondary'),
  /** 点击后发送给 Agent 的文本（kind=reply 时使用） */
  message: z.string().max(2000).optional(),
  /** 点击后调用的工具名（如 asset.regenerate） */
  tool: z.string().max(128).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type CardAction = z.infer<typeof cardActionSchema>;

/** 结果卡片媒体项 */
export const cardMediaSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'text']),
  url: z.string().max(2000).optional(),
  /** 关联资产，便于「采用 / 重新生成」 */
  assetId: idSchema.optional(),
  thumbnailUrl: z.string().max(2000).optional(),
  caption: z.string().max(500).optional(),
});

/** Result Card（文档第 12 条） */
export const resultCardPayloadSchema = z.object({
  type: z.literal('result_card'),
  /** 卡片标题，如「角色已创建」 */
  title: z.string().min(1).max(200),
  /** 卡片类别，决定图标与配色（禁止用 Emoji 充当图标） */
  category: z.enum([
    'character',
    'scene',
    'product',
    'brand',
    'digital_human',
    'script',
    'storyboard',
    'image',
    'video',
    'audio',
    'subtitle',
    'output',
    'asset',
    'info',
  ]),
  /** 主标题下方的副标题，如角色名 */
  subtitle: z.string().max(200).optional(),
  /** 属性行，如 [["古装","黑长发"],["23岁","女"]] */
  attributes: z.array(z.tuple([z.string().max(64), z.string().max(200)])).max(12).optional(),
  media: z.array(cardMediaSchema).max(9).default([]),
  /** 关联资产 / 内容 */
  assetId: idSchema.optional(),
  contentId: idSchema.optional(),
  taskId: idSchema.optional(),
  actions: z.array(cardActionSchema).max(6).default([]),
});

export type ResultCardPayload = z.infer<typeof resultCardPayloadSchema>;

/** 高风险任务的确认请求（文档第 47 条） */
export const confirmationRequestPayloadSchema = z.object({
  type: z.literal('confirmation_request'),
  /** 将要执行的操作摘要 */
  summary: z.string().min(1).max(1000),
  /** 影响面明细，如 [["视频","32 个"],["预计消耗","128 次调用"]] */
  impacts: z.array(z.tuple([z.string().max(64), z.string().max(200)])).max(12).default([]),
  /** 关联任务 */
  taskId: idSchema.optional(),
  /** 确认后执行的任务计划 id */
  planTaskIds: z.array(z.string().max(64)).max(200).default([]),
});

export type ConfirmationRequestPayload = z.infer<typeof confirmationRequestPayloadSchema>;

/** 进度消息 */
export const progressPayloadSchema = z.object({
  type: z.literal('progress'),
  taskId: idSchema.optional(),
  /** 0~100 */
  progress: z.number().min(0).max(100),
  /** 面向用户的一句话说明，如「正在生成第 3 个镜头……」 */
  message: z.string().max(500),
});

export type ProgressPayload = z.infer<typeof progressPayloadSchema>;

/** 错误消息：必须提供用户可理解的原因与处置方式（文档第 66 条） */
export const errorPayloadSchema = z.object({
  type: z.literal('error'),
  /** 面向用户的标题，如「生成视频失败」 */
  title: z.string().min(1).max(200),
  /** 用户可理解的原因，如「模型服务暂时不可用」 */
  reason: z.string().max(1000),
  /** 建议的处置方式 */
  suggestions: z.array(z.string().max(300)).max(6).default([]),
  /** 是否已自动恢复（如切换备用模型成功） */
  recovered: z.boolean().default(false),
  /** 恢复说明，如「原模型暂时不可用，已自动切换备用模型继续生成」 */
  recoveryNote: z.string().max(1000).optional(),
  actions: z.array(cardActionSchema).max(6).default([]),
  taskId: idSchema.optional(),
  /** 内部错误码，仅用于日志关联，不直接展示 */
  code: z.string().max(128).optional(),
});

export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

/** 消息的结构化载荷联合 */
export const messagePayloadSchema = z.discriminatedUnion('type', [
  planPayloadSchema,
  resultCardPayloadSchema,
  confirmationRequestPayloadSchema,
  progressPayloadSchema,
  errorPayloadSchema,
]);

export type MessagePayload = z.infer<typeof messagePayloadSchema>;

/* -------------------------------------------------------------------------- */
/* 请求                                                                        */
/* -------------------------------------------------------------------------- */

/** Agent 对话请求（文档第 71 条） */
export const agentChatRequestSchema = z.object({
  projectId: idSchema,
  /** 不传则自动创建新 Session */
  sessionId: idSchema.optional(),
  /** 关联的 Content（在具体内容上下文中对话时传入） */
  contentId: idSchema.optional(),
  message: z.string().min(1, '消息不能为空').max(20000),
  /** 附件（用户上传的参考素材） */
  attachments: z
    .array(
      z.object({
        kind: z.enum(['image', 'video', 'audio', 'document']),
        url: z.string().max(2000).optional(),
        assetId: idSchema.optional(),
        name: z.string().max(300).optional(),
      }),
    )
    .max(10)
    .default([]),
  /** 消息中引用的资产（解析 @苏晚 得到） */
  referencedAssetIds: z.array(idSchema).max(50).default([]),
});

export type AgentChatRequest = z.infer<typeof agentChatRequestSchema>;

/** 创建 Session */
export const createSessionSchema = z.object({
  projectId: idSchema.optional(),
  contentId: idSchema.optional(),
  title: z.string().max(200).optional(),
});

/** 记录消息 */
export const appendMessageSchema = z.object({
  sessionId: idSchema,
  role: messageRoleSchema,
  direction: messageDirectionSchema,
  kind: messageKindSchema.default('text'),
  content: z.string().max(100000).default(''),
  payload: messagePayloadSchema.optional(),
  /** 结构化的工具调用记录 */
  toolCalls: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  taskId: idSchema.optional(),
  /** 本次消息消耗的 token 估算 */
  tokens: z.number().int().nonnegative().optional(),
  /** 使用的模型 */
  modelId: z.string().max(128).optional(),
});

export type AppendMessageInput = z.infer<typeof appendMessageSchema>;
