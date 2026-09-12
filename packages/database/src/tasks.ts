/**
 * 任务运行时仓储
 *
 * 本文件把 `@svh/domain/task-runtime.ts` 定义的契约**真正接进执行路径**。
 * Phase 0 审计特别指出：参考项目的状态机白名单写了却没接进执行路径，
 * 等于只是一份文档。因此这里每一次状态写入都会先调用
 * `assertTaskTransition`，非法转移直接抛错。
 *
 * ── 幂等三件套 ──
 *   1. DB 唯一键   `@@unique([projectId, idempotencyKey])`
 *   2. 确定性 jobId `task-{taskId}-attempt-{n}`（见 @svh/domain buildJobId）
 *   3. CAS 闸门    `claimTask` 用 updateMany + 状态条件原子抢占
 *
 * ── Fencing ──
 * 所有终态与进度写入都必须携带租约令牌（workerId + leaseVersion），
 * 版本不匹配即拒绝，防止失去租约的旧 Worker 覆盖新 Worker 的结果。
 *
 * ── 领域层重试 ──
 * BullMQ 的 attempts 恒为 1；重试由本文件的 `failTask` 推进 attempt 序号
 * 并返回下一次尝试的调度信息，由调用方（Worker）以延迟作业重新入队。
 * 只有这样才能在重试前切换模型，并让重试计数与状态回写同事务提交。
 */
import {
  assertTaskTransition,
  buildJobId,
  DEFAULT_LEASE_MS,
  isTerminalStatus,
  type TaskQueueName,
  type TaskStatusValue,
} from '@svh/domain';

import { prisma, type Prisma } from './client.js';

/** 创建任务的结果 */
export interface CreateTaskResult {
  taskId: string;
  /** 是否命中了已有任务（幂等） */
  deduplicated: boolean;
  /** 应当入队的作业 id */
  jobId: string;
  /** 该任务所属的资源池队列 */
  queueName: TaskQueueName;
}

/** 抢占租约的结果 */
export type ClaimResult =
  | { ok: true; taskId: string; attempt: number; leaseVersion: number; workerId: string }
  | { ok: false; reason: 'not_found' | 'terminal' | 'already_leased' | 'superseded' };

/** Fencing 令牌 */
export interface FencingContext {
  taskId: string;
  workerId: string;
  leaseVersion: number;
  attempt: number;
}

/** 创建任务（带幂等键） */
export async function createTask(input: {
  projectId: string;
  skillId: string;
  queueName: TaskQueueName;
  input?: Record<string, unknown>;
  contentId?: string | null;
  sessionId?: string | null;
  risk?: 'low' | 'medium' | 'high';
  maxAttempts?: number;
  /**
   * 初始状态。
   *
   * `waiting_user` 用于「执行前需用户确认」的高风险任务：先落库、但**不入队**。
   * 这样确认动作有真实对象，用户刷新页面也不会丢失待确认的操作。
   */
  initialStatus?: 'pending' | 'waiting_user';
  idempotencyKey?: string | null;
  workflowRunId?: string | null;
  workflowNodeKey?: string | null;
}): Promise<CreateTaskResult> {
  const idempotencyKey = input.idempotencyKey ?? null;

  // ① 幂等闸门：命中已有任务则直接复用，不重复入队
  if (idempotencyKey !== null) {
    const existing = await prisma.agentTask.findUnique({
      where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey } },
      select: { id: true, queueName: true, attempts: true },
    });
    if (existing) {
      const queueName = (existing.queueName ?? input.queueName) as TaskQueueName;
      return {
        taskId: existing.id,
        deduplicated: true,
        jobId: buildJobId(existing.id, Math.max(existing.attempts, 1)),
        queueName,
      };
    }
  }

  const task = await prisma.agentTask.create({
    data: {
      projectId: input.projectId,
      skillId: input.skillId,
      queueName: input.queueName,
      input: (input.input ?? {}) as Prisma.InputJsonValue,
      status: input.initialStatus ?? 'pending',
      risk: input.risk ?? 'low',
      maxAttempts: input.maxAttempts ?? 3,
      ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      ...(input.contentId != null ? { contentId: input.contentId } : {}),
      ...(input.sessionId != null ? { sessionId: input.sessionId } : {}),
      ...(input.workflowRunId != null ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowNodeKey != null ? { workflowNodeKey: input.workflowNodeKey } : {}),
    },
    select: { id: true },
  });

  return {
    taskId: task.id,
    deduplicated: false,
    jobId: buildJobId(task.id, 1),
    queueName: input.queueName,
  };
}

/**
 * 抢占任务租约（CAS 闸门）。
 *
 * 并发安全性来自 `updateMany` 的条件更新：只有当前状态仍是 pending
 * （或租约已过期的 running）时才会被更新，因此多个 Worker 同时抢占
 * 只有一个会成功。
 */
export async function claimTask(input: {
  taskId: string;
  workerId: string;
  leaseMs?: number;
}): Promise<ClaimResult> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS));

  const task = await prisma.agentTask.findUnique({
    where: { id: input.taskId },
    select: { id: true, status: true, attempts: true, maxAttempts: true, lease: { select: { leaseUntil: true, leaseVersion: true } } },
  });
  if (!task) return { ok: false, reason: 'not_found' };

  const status = task.status as TaskStatusValue;
  if (isTerminalStatus(status)) return { ok: false, reason: 'terminal' };

  // waiting_user 表示任务在高风险操作前等待用户确认，不能被抢占执行
  if (status === 'waiting_user') return { ok: false, reason: 'superseded' };

  const leaseActive = task.lease !== null && task.lease.leaseUntil.getTime() > now.getTime();
  if (leaseActive) return { ok: false, reason: 'already_leased' };

  const nextAttempt = task.attempts + 1;
  const nextLeaseVersion = (task.lease?.leaseVersion ?? 0) + 1;

  // 状态转移合法性先过白名单；pending → running 与 running → running（租约过期后重抢）
  assertTaskTransition(status, 'running');

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // CAS：只有状态与尝试序号仍与读取时一致才更新
    const result = await tx.agentTask.updateMany({
      where: {
        id: input.taskId,
        status: task.status,
        attempts: task.attempts,
      },
      data: {
        status: 'running',
        attempts: nextAttempt,
        startedAt: now,
        jobId: buildJobId(input.taskId, nextAttempt),
      },
    });
    if (result.count === 0) return null;

    await tx.taskLease.upsert({
      where: { taskId: input.taskId },
      create: {
        taskId: input.taskId,
        workerId: input.workerId,
        leaseUntil,
        leaseVersion: nextLeaseVersion,
        heartbeatAt: now,
      },
      // 递增 fencing 令牌：旧 Worker 手中的令牌从此失效
      update: {
        workerId: input.workerId,
        leaseUntil,
        leaseVersion: nextLeaseVersion,
        heartbeatAt: now,
      },
    });

    await tx.taskAttempt.create({
      data: {
        taskId: input.taskId,
        attempt: nextAttempt,
        status: 'running',
        workerId: input.workerId,
        leaseVersion: nextLeaseVersion,
      },
    });

    return { attempt: nextAttempt, leaseVersion: nextLeaseVersion };
  });

  if (updated === null) return { ok: false, reason: 'superseded' };

  return {
    ok: true,
    taskId: input.taskId,
    attempt: updated.attempt,
    leaseVersion: updated.leaseVersion,
    workerId: input.workerId,
  };
}

/** 续约（心跳）。同样做 Fencing 校验，防止已被接管的租约被续期。 */
export async function renewLease(
  ctx: FencingContext,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const now = new Date();
  const result = await prisma.taskLease.updateMany({
    where: {
      taskId: ctx.taskId,
      workerId: ctx.workerId,
      leaseVersion: ctx.leaseVersion,
    },
    data: { leaseUntil: new Date(now.getTime() + leaseMs), heartbeatAt: now },
  });
  return result.count > 0;
}

/**
 * 上报进度。
 *
 * 硬性要求：`progress` 单调不减（前端进度条不能倒退），
 * 且必须持有有效租约 —— 两者都由 SQL 条件保证。
 */
export async function updateTaskProgress(
  ctx: FencingContext,
  progress: number,
  message?: string,
): Promise<boolean> {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));

  const result = await prisma.agentTask.updateMany({
    where: {
      id: ctx.taskId,
      status: 'running',
      progress: { lte: clamped },
      lease: { workerId: ctx.workerId, leaseVersion: ctx.leaseVersion },
    },
    data: {
      progress: clamped,
      ...(message !== undefined ? { progressMessage: message } : {}),
    },
  });
  return result.count > 0;
}

/** 记录任务子步骤（供 Agent UI 展示执行轨迹） */
export async function appendTaskStep(input: {
  taskId: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  modelId?: string;
  durationMs?: number;
}): Promise<void> {
  const last = await prisma.agentTaskStep.findFirst({
    where: { taskId: input.taskId },
    orderBy: { index: 'desc' },
    select: { index: true },
  });
  const nextIndex = (last?.index ?? 0) + 1;

  await prisma.agentTaskStep.create({
    data: {
      taskId: input.taskId,
      index: nextIndex,
      name: input.name,
      status: input.status,
      ...(input.input !== undefined ? { input: input.input as Prisma.InputJsonValue } : {}),
      ...(input.output !== undefined ? { output: input.output as Prisma.InputJsonValue } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    },
  });
}

/** 成功完成。终态写入必须带 Fencing 令牌。 */
export async function completeTask(
  ctx: FencingContext,
  output: Record<string, unknown>,
  options: { durationMs?: number; modelId?: string | null; usage?: Record<string, unknown> } = {},
): Promise<boolean> {
  assertTaskTransition('running', 'success');

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated = await tx.agentTask.updateMany({
      where: {
        id: ctx.taskId,
        status: 'running',
        lease: { workerId: ctx.workerId, leaseVersion: ctx.leaseVersion },
      },
      data: {
        status: 'success',
        output: output as Prisma.InputJsonValue,
        progress: 100,
        progressMessage: null,
        error: null,
        errorMessage: null,
        finishedAt: new Date(),
      },
    });
    if (updated.count === 0) return false;

    await tx.taskAttempt.updateMany({
      where: { taskId: ctx.taskId, attempt: ctx.attempt },
      data: {
        status: 'success',
        finishedAt: new Date(),
        ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
        ...(options.modelId != null ? { modelId: options.modelId } : {}),
        ...(options.usage !== undefined ? { usage: options.usage as Prisma.InputJsonValue } : {}),
        leaseVersion: ctx.leaseVersion,
      },
    });

    await tx.taskLease.deleteMany({ where: { taskId: ctx.taskId, leaseVersion: ctx.leaseVersion } });
    return true;
  });

  return result;
}

/** 失败处理的结果：是否需要（以及如何）重试 */
export interface FailResult {
  /** 是否已进入 failed 终态 */
  terminal: boolean;
  /** 是否需要重试 */
  shouldRetry: boolean;
  /** 下一次尝试的序号与作业 id（shouldRetry 时有值） */
  nextAttempt?: number;
  nextJobId?: string;
  /** 重试延迟（毫秒），指数退避 + 抖动 */
  retryDelayMs?: number;
}

/**
 * 计算重试退避时间。
 *
 * 指数退避 + 抖动：抖动用于避免多个任务在同一时刻集中重试，
 * 把 Provider 的瞬时故障放大成雪崩。
 */
export function computeRetryDelay(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = Math.random() * baseMs;
  return Math.round(exponential + jitter);
}

/**
 * 标记失败，并决定是否重试。
 *
 * 注意：这里**不直接入队**，只把「是否需要重试、下一次尝试序号、延迟」返回给
 * 调用方（Worker）。理由：入队是外部副作用，必须发生在事务提交**之后**，
 * 否则会出现「作业已入队但事务回滚」的悬挂任务。
 */
export async function failTask(
  ctx: FencingContext,
  error: { message: string; userMessage?: string; retryable?: boolean },
  options: { durationMs?: number; modelId?: string | null; baseRetryDelayMs?: number } = {},
): Promise<FailResult> {
  const task = await prisma.agentTask.findUnique({
    where: { id: ctx.taskId },
    select: { attempts: true, maxAttempts: true },
  });
  if (!task) return { terminal: true, shouldRetry: false };

  // 可重试的前提：错误本身可重试 + 还有剩余尝试次数
  const hasBudget = task.attempts < task.maxAttempts;
  const shouldRetry = (error.retryable ?? true) && hasBudget;
  const nextAttempt = task.attempts + 1;
  const nextStatus: TaskStatusValue = shouldRetry ? 'pending' : 'failed';

  assertTaskTransition('running', nextStatus);

  const retryDelayMs = shouldRetry
    ? computeRetryDelay(task.attempts, options.baseRetryDelayMs ?? 1000)
    : undefined;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 只有仍持有租约才允许写入，避免旧 Worker 覆盖新尝试的状态
    const updated = await tx.agentTask.updateMany({
      where: {
        id: ctx.taskId,
        status: 'running',
        lease: { workerId: ctx.workerId, leaseVersion: ctx.leaseVersion },
      },
      data: {
        status: nextStatus,
        error: error.message,
        errorMessage: error.userMessage ?? null,
        // 重试时清空进度，让下一次尝试从 0 重新上报
        ...(shouldRetry ? { progress: 0, progressMessage: null } : { finishedAt: new Date() }),
        ...(shouldRetry && retryDelayMs !== undefined
          ? { jobId: buildJobId(ctx.taskId, nextAttempt) }
          : {}),
      },
    });

    if (updated.count === 0) return;

    await tx.taskAttempt.updateMany({
      where: { taskId: ctx.taskId, attempt: ctx.attempt },
      data: {
        status: 'failed',
        error: error.message,
        finishedAt: new Date(),
        leaseVersion: ctx.leaseVersion,
        ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
        ...(options.modelId != null ? { modelId: options.modelId } : {}),
      },
    });

    // 释放租约：下一次尝试需要重新抢占
    await tx.taskLease.deleteMany({ where: { taskId: ctx.taskId, leaseVersion: ctx.leaseVersion } });
  });

  return {
    terminal: !shouldRetry,
    shouldRetry,
    ...(shouldRetry
      ? { nextAttempt, nextJobId: buildJobId(ctx.taskId, nextAttempt), retryDelayMs }
      : {}),
  };
}

/** 取消任务（用户主动取消或流程中止） */
export async function cancelTask(taskId: string, reason?: string): Promise<boolean> {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    select: { status: true },
  });
  if (!task) return false;

  const status = task.status as TaskStatusValue;
  if (isTerminalStatus(status)) return false;
  assertTaskTransition(status, 'cancelled');

  const result = await prisma.agentTask.updateMany({
    where: { id: taskId, status: task.status },
    data: {
      status: 'cancelled',
      finishedAt: new Date(),
      ...(reason !== undefined ? { errorMessage: reason } : {}),
    },
  });

  await prisma.taskLease.deleteMany({ where: { taskId } });
  return result.count > 0;
}

/** 将任务置为等待用户确认（高风险操作，技术文档第 47 条） */
export async function parkTaskForConfirmation(
  ctx: FencingContext,
  summary: string,
): Promise<boolean> {
  assertTaskTransition('running', 'waiting_user');

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated = await tx.agentTask.updateMany({
      where: {
        id: ctx.taskId,
        status: 'running',
        lease: { workerId: ctx.workerId, leaseVersion: ctx.leaseVersion },
      },
      data: { status: 'waiting_user', progressMessage: summary },
    });
    if (updated.count === 0) return false;
    await tx.taskLease.deleteMany({ where: { taskId: ctx.taskId, leaseVersion: ctx.leaseVersion } });
    return true;
  });

  return result;
}

/**
 * 对账：回收租约过期的任务。
 *
 * 审计结论：进程崩溃后必须有人兜底。此函数把「租约已过期且仍处于 running」
 * 的任务重新置为 pending，使其可被再次抢占。
 *
 * @returns 被回收的任务 id 列表（调用方据此重新入队）
 */
export async function reclaimExpiredTasks(limit = 100): Promise<string[]> {
  const now = new Date();
  const expired = await prisma.taskLease.findMany({
    where: { leaseUntil: { lt: now }, task: { status: 'running' } },
    select: { taskId: true, leaseVersion: true },
    take: limit,
    orderBy: { leaseUntil: 'asc' },
  });

  const reclaimed: string[] = [];
  for (const lease of expired) {
    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const result = await tx.agentTask.updateMany({
        where: { id: lease.taskId, status: 'running' },
        data: { status: 'pending' },
      });
      if (result.count === 0) return false;
      // 把该任务仍在 running 的尝试标记为失败（租约过期说明 Worker 已失联）
      await tx.taskAttempt.updateMany({
        where: { taskId: lease.taskId, status: 'running' },
        data: { status: 'failed', error: '租约过期，由对账任务回收', finishedAt: now },
      });
      await tx.taskLease.deleteMany({
        where: { taskId: lease.taskId, leaseVersion: lease.leaseVersion },
      });
      return true;
    });
    if (updated) reclaimed.push(lease.taskId);
  }

  return reclaimed;
}

/** 记录一次模型调用（model_tasks），供成本归因与问题定位 */
export async function recordModelTask(input: {
  providerId: string;
  modelId: string;
  capability: string;
  taskId?: string | null;
  skillId?: string | null;
  prompt: string;
  params?: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: Record<string, unknown>;
  error?: string;
  latencyMs?: number;
  usage?: Record<string, unknown>;
  attempts?: number;
  attemptChain?: unknown[];
}): Promise<string> {
  const record = await prisma.modelTask.create({
    data: {
      providerId: input.providerId,
      modelId: input.modelId,
      capability: input.capability as never,
      status: input.status,
      prompt: input.prompt.slice(0, 20000),
      params: (input.params ?? {}) as Prisma.InputJsonValue,
      ...(input.taskId != null ? { taskId: input.taskId } : {}),
      ...(input.skillId != null ? { skillId: input.skillId } : {}),
      ...(input.result !== undefined ? { result: input.result as Prisma.InputJsonValue } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.usage !== undefined ? { usage: input.usage as Prisma.InputJsonValue } : {}),
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      ...(input.attemptChain !== undefined
        ? { attemptChain: input.attemptChain as Prisma.InputJsonValue }
        : {}),
      ...(input.status === 'succeeded' || input.status === 'failed' ? { finishedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return record.id;
}
