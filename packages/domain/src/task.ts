/**
 * AgentTask（任务）领域模型
 *
 * 对应技术文档第 41、42、44 条。
 *
 * 核心原则：**所有耗时 AI 操作统一 Task 化，Agent 不允许阻塞 HTTP 请求**。
 * API 只负责创建任务并立即返回，真正的执行发生在 Worker 中；
 * 任务通过 EventBus 把进度与结果回推给 Agent 与前端。
 */
import { z } from 'zod';
import { TASK_RISKS } from './enums.js';
import { idSchema } from './common.js';
// 任务状态与执行状态的 Schema/状态机的单一来源在 task-runtime.ts，
// 此处复用而非重复定义，避免同名导出冲突与口径漂移。
import { executionStatusSchema, taskStatusSchema } from './task-runtime.js';

export const taskRiskSchema = z.enum(TASK_RISKS);

/** 终态任务状态：不再变化 */
export const TERMINAL_TASK_STATUSES = ['success', 'failed', 'cancelled'] as const;

/** 判断任务是否处于终态 */
export function isTerminalTaskStatus(status: z.infer<typeof taskStatusSchema>): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * AgentTask（文档第 41 条）。
 *
 * `progress` 统一使用 0~100 的整数，便于前端进度条直接消费；
 * `Worker` 通过 `updateTaskProgress` 上报，且必须保证单调不减。
 */
export interface AgentTask {
  id: string;
  projectId: string;
  contentId?: string | null;
  sessionId?: string | null;
  /** 执行该任务的 Skill id，如 image.generate */
  skillId: string;
  status: z.infer<typeof taskStatusSchema>;
  /** 风险等级：high 需要用户确认后才执行 */
  risk: z.infer<typeof taskRiskSchema>;
  /** Skill 输入参数 */
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: string | null;
  /** 面向用户的错误说明 */
  errorMessage?: string | null;
  /** 0~100 */
  progress: number;
  /** 面向用户的当前状态描述，如「正在生成第 3 个镜头」 */
  progressMessage?: string | null;
  /** 重试次数（含自动重试） */
  attempts: number;
  maxAttempts: number;
  /** 幂等键：防止重复入队 */
  idempotencyKey?: string | null;
  /** 所属 Workflow Run 与节点 */
  workflowRunId?: string | null;
  workflowNodeKey?: string | null;
  /** 队列中的作业 id（BullMQ jobId） */
  jobId?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建任务请求 */
export const createTaskSchema = z.object({
  projectId: idSchema,
  contentId: idSchema.optional(),
  sessionId: idSchema.optional(),
  skillId: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()).default({}),
  /** 不传则取 Skill 定义中的默认风险等级 */
  risk: taskRiskSchema.optional(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  idempotencyKey: z.string().max(200).optional(),
  workflowRunId: idSchema.optional(),
  workflowNodeKey: z.string().max(128).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/** 进度上报 */
export const taskProgressSchema = z.object({
  taskId: idSchema,
  /** 必须单调不减，取 max(旧值, 新值) */
  progress: z.number().min(0).max(100),
  /** 面向用户的一句话描述 */
  message: z.string().max(500).optional(),
});

export type TaskProgressInput = z.infer<typeof taskProgressSchema>;

/** 任务步骤（agent_task_steps）：一次任务内部的细粒度执行轨迹 */
export interface AgentTaskStep {
  id: string;
  taskId: string;
  /** 步骤序号，从 1 开始 */
  index: number;
  /** 步骤名，如「编译提示词」「调用模型」「保存资产」 */
  name: string;
  status: z.infer<typeof executionStatusSchema>;
  /** 步骤输入 / 输出摘要（用于问题定位与结果回放） */
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: string | null;
  /** 实际使用的模型 */
  modelId?: string | null;
  /** 模型调用耗时（毫秒） */
  durationMs?: number | null;
  createdAt: Date;
}

/** 任务查询过滤条件 */
export const taskQuerySchema = z.object({
  projectId: idSchema.optional(),
  contentId: idSchema.optional(),
  sessionId: idSchema.optional(),
  status: z.union([taskStatusSchema, z.array(taskStatusSchema)]).optional(),
  skillId: z.string().max(128).optional(),
  workflowRunId: idSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export type TaskQuery = z.infer<typeof taskQuerySchema>;
