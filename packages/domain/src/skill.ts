/**
 * Skill（技能）领域模型
 *
 * 对应技术文档第 19~22 条。
 *
 * 核心原则：**Agent 不直接绑定具体模型**。
 *
 * ```
 * Creative Agent → Skill Registry → Skill → Model Router → Provider → Model
 * ```
 *
 * Skill 是「能力声明」，不是「模型封装」：
 * - 声明自己需要什么能力（capability）、什么输入输出结构
 * - 由 Model Router 决定用哪个模型执行
 * - 通过 accessTier 做会员权限检查
 */
import { z } from 'zod';
import { SKILL_ACCESS_TIERS } from './enums.js';
import { idSchema } from './common.js';
// modelCapabilitySchema 的唯一来源是 model.ts，此处复用避免同名导出冲突
import { modelCapabilitySchema } from './model.js';
import { executionStatusSchema } from './task-runtime.js';

export const skillAccessTierSchema = z.enum(SKILL_ACCESS_TIERS);

/** Skill 类别：决定其在 /技能 列表中的分组 */
export const SKILL_CATEGORIES = [
  'text',
  'script',
  'image',
  'video',
  'audio',
  'voice',
  'digital_human',
  'subtitle',
  'edit',
  'asset',
  'workflow',
] as const;
export const skillCategorySchema = z.enum(SKILL_CATEGORIES);
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** Skill 类别中文名 */
export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = {
  text: '文本',
  script: '脚本',
  image: '图片',
  video: '视频',
  audio: '音频',
  voice: '配音',
  digital_human: '数字人',
  subtitle: '字幕',
  edit: '剪辑',
  asset: '资产',
  workflow: '工作流',
};

/** JSON Schema 子集：Skill 的输入 / 输出契约 */
export const jsonSchemaSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    required: z.array(z.string()).default([]),
    description: z.string().max(2000).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

/**
 * Skill 定义（文档第 22 条）。
 *
 * `inputSchema` / `outputSchema` 使用 JSON Schema 表达，
 * 一是便于暴露给 LLM 做 Function Calling，
 * 二是可以持久化到 skills 表做展示与校验。
 */
export const skillDefinitionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'Skill id 必须形如 image.generate'),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, '版本号必须形如 1.0.0').default('1.0.0'),
  category: skillCategorySchema,
  /**
   * 该 Skill 依赖的模型能力，Model Router 据此挑选候选模型。
   *
   * 允许为空数组：剪辑、渲染、资产增删改等技能**不需要调用任何模型**，
   * 它们由本地 Worker 直接完成。因此这里不做 min(1) 约束，
   * 但 Model Router 必须对「capabilities 为空」的技能明确跳过模型选择
   * （而不是报错或随机挑一个模型）。
   */
  capabilities: z.array(modelCapabilitySchema),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema,
  /** 风险等级：high 表示高成本，执行前必须用户确认 */
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  /** 权限等级 */
  accessTier: skillAccessTierSchema.default('free'),
  /** 预计耗时（秒），用于前端提示「可以离开页面」 */
  estimatedSeconds: z.number().positive().max(7200).optional(),
  /** 是否可取消 */
  cancellable: z.boolean().default(true),
  /** 是否可重试 */
  retryable: z.boolean().default(true),
  /** 该 Skill 是否需要用户先提供确认 */
  requiresConfirmation: z.boolean().default(false),
  /** 中文展示名，用于 /技能 菜单 */
  aliases: z.array(z.string().max(64)).max(20).default([]),
  /** 面向用户的一句话说明（禁止暴露技术细节） */
  userHint: z.string().max(500).optional(),
  /** 是否对用户隐藏（内部 Skill） */
  hidden: z.boolean().default(false),
});

export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

/** Skill 执行记录 */
export const skillExecutionSchema = z.object({
  id: idSchema,
  skillId: z.string().max(128),
  taskId: idSchema,
  status: executionStatusSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().max(5000).nullable().default(null),
  modelId: z.string().max(128).nullable().optional(),
  startedAt: z.date().nullable().optional(),
  finishedAt: z.date().nullable().optional(),
});

export type SkillExecution = z.infer<typeof skillExecutionSchema>;

/** Skill 执行上下文：由 Skill Engine 注入，Skill 实现只依赖该接口 */
export interface SkillContext {
  taskId: string;
  projectId: string;
  contentId?: string | null;
  sessionId?: string | null;
  /** 上报进度 */
  reportProgress(progress: number, message?: string): Promise<void>;
  /** 记录子步骤 */
  step(name: string, detail?: Record<string, unknown>): Promise<void>;
  /** 取消信号 */
  signal: AbortSignal;
  /** 日志（仅进日志，不返回给用户） */
  logger: {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}

/** Skill 执行结果 */
export interface SkillResult<TOutput = Record<string, unknown>> {
  output: TOutput;
  /** 执行过程中产出的资产 id 列表 */
  assetIds?: string[];
  /** 面向用户的完成说明 */
  summary?: string;
  /** 结构化结果卡片（可选，用于 Agent UI） */
  card?: Record<string, unknown>;
}

/**
 * Skill 插件接口。
 * 所有 Skill 必须实现该接口，注册进 Skill Registry 后即可被 Agent 调用。
 */
export interface Skill<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> {
  readonly definition: SkillDefinition;
  /** 执行逻辑；不得直接访问数据库，需通过注入的依赖 */
  execute(input: TInput, ctx: SkillContext): Promise<SkillResult<TOutput>>;
}

/** Agent 可调用的工具定义（文档第 53、54 条） */
export const agentToolDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, '工具名必须形如 asset.search'),
  description: z.string().min(1).max(2000),
  parameters: jsonSchemaSchema,
  /** 是否属于写操作（写操作在保守模式下需要确认） */
  mutating: z.boolean().default(false),
});

export type AgentToolDefinition = z.infer<typeof agentToolDefinitionSchema>;
