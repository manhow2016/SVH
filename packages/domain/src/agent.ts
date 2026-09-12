/**
 * Creative Agent 领域契约
 *
 * 对应技术文档第 6~8、53~56 条。本文件定义 Agent 的**协议**，
 * 不包含实现 —— 实现放在 `@svh/agent`。
 *
 * 核心约束（技术文档第 53 条）：**Agent 不直接修改数据库**，
 * 一切操作经由工具（Tool）完成。因此工具契约是 Agent 与业务系统之间
 * 唯一的通道，必须先把它的形状固定下来。
 */
import { z } from 'zod';

import { CONTENT_TYPES } from './enums.js';
import { idSchema } from './common.js';

/* -------------------------------------------------------------------------- */
/* 意图分析                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 用户意图分类。
 *
 * 分类决定 Agent 走哪条执行路径，因此粒度要够用但不能过细 ——
 * 过细的分类会让模型在小样本上难以稳定区分。
 */
export const AGENT_INTENTS = [
  /** 创建新内容（"帮我做一个 30 秒广告"） */
  'create_content',
  /** 修改已有内容（"把第三个镜头改成夜景"） */
  'modify_content',
  /** 生成某类资产（"设计一个古装女主"） */
  'create_asset',
  /** 修改已有资产（"女主换成黑色长发"） */
  'modify_asset',
  /** 查询信息（"这个项目现在有哪些内容"） */
  'query',
  /** 让 Agent 解释或给出建议（"这个广告怎么改更有科技感"） */
  'advise',
  /** 继续上一步（"继续"、"开始制作"） */
  'continue',
  /** 其他 / 无法判定 */
  'other',
] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];
export const agentIntentSchema = z.enum(AGENT_INTENTS);

/** 意图的中文说明，用于结果卡片与日志 */
export const INTENT_LABELS: Record<AgentIntent, string> = {
  create_content: '创建内容',
  modify_content: '修改内容',
  create_asset: '创建资产',
  modify_asset: '修改资产',
  query: '查询',
  advise: '建议',
  continue: '继续',
  other: '其他',
};

/**
 * 局部修改的定位结果。
 *
 * 对应技术文档第 91 条的验收要求：「把第三个镜头改成夜景」应当
 * **只改 Shot 03**，而不是重建整个项目。因此意图分析必须定位到具体目标。
 */
export const modificationTargetSchema = z.object({
  /** 目标类型 */
  kind: z.enum(['content', 'asset', 'shot', 'scene', 'character', 'output']),
  /** 目标 id（若能确定） */
  id: idSchema.optional(),
  /** 目标引用名（如 `@苏晚` 解析出的名字） */
  slug: z.string().max(64).optional(),
  /** 序号（"第三个镜头" → 3） */
  index: z.number().int().positive().optional(),
  /** 人类可读描述，用于回显给用户确认 */
  label: z.string().max(200),
});

export type ModificationTarget = z.infer<typeof modificationTargetSchema>;

/** 意图分析结果 */
export const intentAnalysisSchema = z.object({
  intent: agentIntentSchema,
  /** 识别出的内容类型（仅 create_content 有意义） */
  contentType: z.enum(CONTENT_TYPES).optional(),
  /** 置信度 0~1；低于阈值时 Agent 应当追问而不是猜测 */
  confidence: z.number().min(0).max(1).default(0.5),
  /** 提取到的创作参数（时长、平台、受众、风格…） */
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** 局部修改的目标 */
  targets: z.array(modificationTargetSchema).max(20).default([]),
  /** 修改指令的语义描述（"改成夜景"） */
  modification: z.string().max(1000).optional(),
  /** 用户消息中出现的 @引用名 */
  mentions: z.array(z.string().max(64)).max(50).default([]),
  /** 若信息不足，需要向用户追问的问题 */
  clarifyingQuestion: z.string().max(500).optional(),
  /** 分析依据（一句话），让用户理解 Agent 为什么这样判断 */
  rationale: z.string().max(1000).optional(),
});

export type IntentAnalysis = z.infer<typeof intentAnalysisSchema>;

/** 置信度低于此值时，Agent 应追问而非直接执行 */
export const INTENT_CONFIDENCE_THRESHOLD = 0.6;

/* -------------------------------------------------------------------------- */
/* 工具调用                                                                    */
/* -------------------------------------------------------------------------- */

/** 一次工具调用的记录 */
export const toolCallRecordSchema = z.object({
  /** 工具名，如 asset.search */
  name: z.string().min(1).max(128),
  /** 调用入参 */
  arguments: z.record(z.string(), z.unknown()).default({}),
  /** 执行状态 */
  status: z.enum(['pending', 'success', 'failed', 'rejected']).default('pending'),
  /** 执行结果（成功时） */
  result: z.unknown().optional(),
  /** 失败原因（面向用户） */
  error: z.string().max(2000).optional(),
  /** 是否因为需要用户确认而被拒绝 */
  requiresConfirmation: z.boolean().default(false),
  durationMs: z.number().int().nonnegative().optional(),
});

export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

/** 工具执行上下文（由 Agent 运行时提供） */
export interface ToolExecutionContext {
  /** 当前会话与项目 */
  sessionId: string | null;
  projectId: string;
  contentId: string | null;
  /** 用户会员等级，用于技能权限检查 */
  tier?: 'free' | 'pro' | 'enterprise';
  /** 本次任务使用的待确认策略 */
  confirmationPolicy: 'reject' | 'allow';
  /** 取消信号 */
  signal: AbortSignal;
  /** 记录一次工具调用（供审计与 UI 展示） */
  recordCall(record: ToolCallRecord): void;
}

/** 工具执行结果 */
export interface ToolExecutionResult {
  ok: boolean;
  /** 返回给模型的结果（会被序列化进下一轮对话） */
  result?: unknown;
  /** 面向用户的说明 */
  message?: string;
  error?: string;
  /** 需要用户确认时置为 true，Agent 应停止本轮并发出确认请求 */
  requiresConfirmation?: boolean;
}

/** Agent 工具的实现接口 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 形态的入参契约（供 LLM Function Calling 使用） */
  readonly parameters: Record<string, unknown>;
  /** 是否写操作 */
  readonly mutating: boolean;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

/* -------------------------------------------------------------------------- */
/* Agent 轮次结果                                                              */
/* -------------------------------------------------------------------------- */

/** Agent 一轮对话的产出 */
export const agentTurnResultSchema = z.object({
  /** 面向用户的自然语言回复 */
  message: z.string(),
  /** 结构化载荷（计划 / 结果卡片 / 确认请求），供 UI 渲染 */
  payload: z.unknown().optional(),
  /** 本轮调用的工具 */
  toolCalls: z.array(toolCallRecordSchema).default([]),
  /** 终结状态 */
  state: z.enum(['completed', 'waiting_user', 'failed']),
  /** 本轮消耗的 token 估算 */
  tokens: z.number().int().nonnegative().default(0),
  /** 本轮使用的模型 */
  modelId: z.string().max(128).optional(),
  /** 迭代轮数（多步工具调用时 > 1） */
  iterations: z.number().int().nonnegative().default(0),
});

export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;

/** Context Resolver 的产出：装配好的上下文 */
export interface ResolvedContext {
  /** 项目记忆（结构化） */
  projectMemory: Record<string, unknown>;
  /** 项目内的资产摘要（只含 id / slug / name / type，不含完整 metadata） */
  assetSummaries: Array<{ id: string; slug: string; name: string; type: string }>;
  /** 用户消息中 @引用 命中的资产（含完整信息） */
  referencedAssets: Array<{
    id: string;
    slug: string;
    name: string;
    type: string;
    summary: string;
  }>;
  /** 关联内容（若在具体内容上下文中对话） */
  content: {
    id: string;
    type: string;
    title: string;
    brief: string;
    status: string;
    metadata: Record<string, unknown>;
  } | null;
  /** 最近若干轮对话（按需裁剪） */
  recentMessages: Array<{ role: string; content: string }>;
  /** 装配说明（哪些被加载、哪些被跳过），用于调试与向用户解释 */
  notes: string[];
  /** 估算的 token 数 */
  estimatedTokens: number;
}
