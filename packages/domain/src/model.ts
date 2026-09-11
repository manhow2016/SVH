/**
 * Model Router 领域模型
 *
 * 对应技术文档第 29、30、67 条。
 *
 * 两条硬性约束：
 * 1. **Agent / Skill 不直接调用模型** —— 一律经过 Model Router。
 * 2. **模型调用与会员系统解耦** —— 模型 API 由用户自带，SVH 只收功能使用费。
 *    因此这里记录的是「用量」，不是「计费」，计费由会员系统另行处理。
 *
 * 安全约束：API Key **禁止**通过任何 Schema 输出到客户端。
 * 对外展示只使用 `ModelProviderView`（不含密钥字段）。
 */
import { z } from 'zod';
import {
  MODEL_CAPABILITIES,
  MODEL_PROVIDER_KINDS,
  MODEL_TASK_STATUSES,
} from './enums.js';
import { idSchema } from './common.js';

export const modelProviderKindSchema = z.enum(MODEL_PROVIDER_KINDS);
export const modelCapabilitySchema = z.enum(MODEL_CAPABILITIES);
export const modelTaskStatusSchema = z.enum(MODEL_TASK_STATUSES);

/** Provider 健康状态：连续失败后 Model Router 会将其降级 */
export const providerHealthSchema = z.enum(['unknown', 'healthy', 'degraded', 'down']);
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

/** 模型能力标签（同时用于筛选与展示） */
export const modelCapabilitiesSchema = z.array(modelCapabilitySchema).min(1);

/* -------------------------------------------------------------------------- */
/* Provider / Model                                                            */
/* -------------------------------------------------------------------------- */

/** 创建 Provider —— 用户自带 API 的接入点（文档第 30 条） */
export const createModelProviderSchema = z.object({
  /** 归属用户；为空表示系统级共享 Provider */
  userId: idSchema.optional(),
  name: z.string().min(1, '名称不能为空').max(128),
  kind: modelProviderKindSchema,
  /** 如 https://api.openai.com/v1 */
  baseUrl: z.string().url('Base URL 格式不正确').max(2000),
  /** 明文密钥，仅在写入时传入，落库前必须加密 */
  apiKey: z.string().min(1).max(4000),
  /** 自定义请求头（如某些中转服务需要的额外鉴权） */
  headers: z.record(z.string(), z.string()).optional(),
  /** 并发上限，防止打爆用户配额 */
  concurrency: z.number().int().min(1).max(100).default(4),
  /** 每分钟请求上限 */
  rateLimitPerMinute: z.number().int().min(1).max(10000).optional(),
  enabled: z.boolean().default(true),
  /** 该 Provider 的额外配置（如 region、projectId） */
  config: z.record(z.string(), z.unknown()).default({}),
});

export type CreateModelProviderInput = z.infer<typeof createModelProviderSchema>;

/** 更新 Provider：apiKey 省略表示不修改 */
export const updateModelProviderSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  baseUrl: z.string().url().max(2000).optional(),
  apiKey: z.string().min(1).max(4000).optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  concurrency: z.number().int().min(1).max(100).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10000).nullable().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Provider 对外视图 —— **绝不包含 apiKey**。
 * 前端展示只允许使用该结构。
 */
export interface ModelProviderView {
  id: string;
  userId: string | null;
  name: string;
  kind: z.infer<typeof modelProviderKindSchema>;
  baseUrl: string;
  /** 是否已配置密钥（不回显密钥本身） */
  hasApiKey: boolean;
  /** 密钥掩码展示，如 sk-****abcd */
  apiKeyMask?: string | null;
  concurrency: number;
  rateLimitPerMinute: number | null;
  enabled: boolean;
  health: ProviderHealth;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 注册到某 Provider 下的具体模型 */
export const createModelSchema = z.object({
  providerId: idSchema,
  /** Provider 侧的模型标识，如 doubao-seedream-3-0-t2i */
  modelKey: z.string().min(1).max(200),
  /** 展示名 */
  displayName: z.string().min(1).max(200),
  capabilities: modelCapabilitiesSchema,
  /** 优先级：数值越大越优先（同能力下） */
  priority: z.number().int().min(0).max(1000).default(100),
  /** 是否支持流式输出 */
  supportsStreaming: z.boolean().default(false),
  /** 是否支持异步任务 + 回调轮询 */
  supportsAsync: z.boolean().default(false),
  /** 上下文窗口（token），文本模型 */
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  /** 最大输出 token */
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  /** 支持的画幅 / 分辨率列表 */
  supportedSizes: z.array(z.string().max(32)).max(50).optional(),
  /** 支持的最长视频时长（秒） */
  maxDurationSeconds: z.number().positive().max(3600).optional(),
  /** 单次调用单价（用户视角，字符串避免浮点误差） */
  unitCost: z.string().max(32).optional(),
  /** 该模型的固定参数默认值（如默认 steps、guidance） */
  defaultParams: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export type CreateModelInput = z.infer<typeof createModelSchema>;

/** 模型对外视图 */
export interface ModelView {
  id: string;
  providerId: string;
  providerName: string;
  providerKind: z.infer<typeof modelProviderKindSchema>;
  modelKey: string;
  displayName: string;
  capabilities: z.infer<typeof modelCapabilitySchema>[];
  priority: number;
  supportsStreaming: boolean;
  supportsAsync: boolean;
  contextWindow: number | null;
  maxDurationSeconds: number | null;
  supportedSizes: string[];
  unitCost: string | null;
  enabled: boolean;
  health: ProviderHealth;
}

/* -------------------------------------------------------------------------- */
/* 路由策略                                                                    */
/* -------------------------------------------------------------------------- */

/** 选模策略 */
export const modelSelectionStrategySchema = z.enum([
  /** 质量优先：取 priority 最高的可用模型 */
  'quality',
  /** 成本优先：取 unitCost 最低的可用模型 */
  'cost',
  /** 速度优先：取 estimatedLatency 最低的可用模型 */
  'speed',
  /** 用户手动指定 modelId */
  'manual',
]);
export type ModelSelectionStrategy = z.infer<typeof modelSelectionStrategySchema>;

/** 重试与降级策略（文档第 67 条：Model A 失败 → Retry → Model B） */
export const modelRoutingPolicySchema = z
  .object({
    strategy: modelSelectionStrategySchema.default('quality'),
    /** 手动指定的模型 id（strategy=manual 时必填） */
    modelId: idSchema.optional(),
    /** 单个模型内的重试次数 */
    maxRetries: z.number().int().min(0).max(10).default(2),
    /** 失败后是否允许切换到备用模型 */
    allowFallback: z.boolean().default(true),
    /** 最多尝试几个不同模型 */
    maxFallbacks: z.number().int().min(0).max(10).default(3),
    /** 单次调用超时（毫秒） */
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
    /** 重试退避基数（毫秒），采用指数退避 */
    backoffMs: z.number().int().min(0).max(60_000).default(1000),
    /** 是否允许使用系统共享 Provider（用户未配置时） */
    allowSharedProviders: z.boolean().default(true),
    /** 本次调用的最大成本上限（用户视角） */
    maxCost: z.string().max(32).optional(),
  })
  .strict();

export type ModelRoutingPolicy = z.infer<typeof modelRoutingPolicySchema>;

/** Model Router 调用请求 */
export const modelInvokeRequestSchema = z.object({
  /** 需要的能力，决定候选模型集合 */
  capability: modelCapabilitySchema,
  /** 提示词（已由 Prompt Compiler 编译完成） */
  prompt: z.string().max(200000),
  /** 负面提示词 */
  negativePrompt: z.string().max(20000).optional(),
  /** 结构化输出约束（文本类能力使用） */
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  /** 模型参数覆盖 */
  params: z.record(z.string(), z.unknown()).default({}),
  /** 参考图（图生图 / 角色一致性 / 首尾帧） */
  referenceImages: z.array(z.string().max(2000)).max(20).default([]),
  routing: modelRoutingPolicySchema.partial().optional(),
});

export type ModelInvokeRequest = z.infer<typeof modelInvokeRequestSchema>;

/** 单次模型调用的结果 */
export interface ModelInvokeResult {
  /** 实际使用的模型 */
  modelId: string;
  providerId: string;
  /** 是否发生了降级切换 */
  fallbackUsed: boolean;
  /** 降级说明，用于生成「已自动切换备用模型」的提示 */
  fallbackNote?: string;
  /** 文本输出 */
  text?: string;
  /** 解析后的结构化输出 */
  data?: unknown;
  /** 生成的媒体文件 */
  files?: Array<{ url?: string; storageKey?: string; mimeType?: string; width?: number; height?: number; duration?: number }>;
  /** 用量统计（与计费解耦，仅记录） */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /** 图片张数 / 视频秒数等 */
    units?: number;
    unitLabel?: string;
  };
  /** 实际耗时（毫秒） */
  latencyMs: number;
  /** 尝试过的模型链路，便于问题定位 */
  attempts: Array<{ modelId: string; ok: boolean; errorCode?: string; durationMs: number }>;
}

/** model_tasks：每次模型调用的持久化记录 */
export interface ModelTaskRecord {
  id: string;
  providerId: string;
  modelId: string;
  /** 关联的 AgentTask 与 Skill */
  taskId?: string | null;
  skillId?: string | null;
  capability: z.infer<typeof modelCapabilitySchema>;
  status: z.infer<typeof modelTaskStatusSchema>;
  /** 编译后的提示词快照 */
  prompt: string;
  params: Record<string, unknown>;
  /** Provider 侧的任务 id（异步任务轮询用） */
  externalId?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  attempts: number;
  latencyMs?: number | null;
  usage?: Record<string, unknown> | null;
  costEstimate?: string | null;
  createdAt: Date;
  finishedAt?: Date | null;
}

/** 判断某模型是否支持所需能力 */
export function supportsCapability(
  model: { capabilities: readonly string[] },
  capability: string,
): boolean {
  return model.capabilities.includes(capability);
}
