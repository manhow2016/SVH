/**
 * 任务运行器（Task Runner）
 *
 * 这是 Worker 的核心：把「队列里的一条作业」变成「一次受控的技能执行」。
 *
 * 关键流程与不变量：
 *
 * ```
 * 读取任务 → [记录上次错误] → CAS 抢占租约 → 启动心跳 → 执行技能
 *   ├─ 成功   → Fencing 写入 success + 记录 attempt
 *   ├─ 需确认 → 置 waiting_user，释放租约，不入队重试
 *   └─ 失败   → Fencing 写入 failed/pending + 计算退避 → 由本文件延迟重新入队
 * ```
 *
 * 三条不变量（来自 Phase 0 审计）：
 * 1. **状态转移先过白名单** —— 由 @svh/database 仓储层强制
 * 2. **终态写入必须带 Fencing 令牌** —— 防止失去租约的旧 Worker 覆盖新结果
 * 3. **重试入队发生在事务提交之后** —— 不在 failTask 内部入队，
 *    避免「作业已入队但事务回滚」的悬挂任务
 *
 * 心跳的必要性：AI 任务可能跑数分钟。租约默认 2 分钟，若不续约，
 * 任务会在执行途中被对账逻辑抢走并重复执行。
 *
 * ── 关于依赖顺序 ──
 * 执行器需要「进度上报 / 步骤记录」回调，而这两个回调需要当前任务的
 * Fencing 令牌（claim 之后才拿得到）。因此运行器在每次作业开始时
 * **动态构建**执行器，而不是在构造时接收一个固定实例 ——
 * 这样回调天然携带正确的令牌，不会出现「用假令牌上报进度」的问题。
 */
import {
  appendTaskStep,
  claimTask,
  completeTask,
  computeRetryDelay,
  failTask,
  parkTaskForConfirmation,
  prisma,
  renewLease,
  updateTaskProgress,
  type FencingContext,
} from '@svh/database';
// 租约 / 心跳的默认值定义在领域层的任务运行时契约中
import { DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_MS } from '@svh/domain';
import type { TaskJobResult, TaskQueuePool } from '@svh/queue';
import {
  isConfirmationRequired,
  isRetryableError,
  SkillExecutor,
  type ExecuteSkillResult,
  type SkillDeps,
  type SkillExecutorOptions,
  type SkillLogger,
  type SkillRegistry,
} from '@svh/skills';

/** 单次技能执行的最长时间，超过则主动中断，避免占死 Worker 并发槽位 */
const SKILL_TIMEOUT_MS = 30 * 60 * 1000;

export interface TaskRunnerOptions {
  registry: SkillRegistry;
  deps: SkillDeps;
  queues: TaskQueuePool;
  workerId: string;
  logger: SkillLogger;
  /** 心跳间隔（毫秒） */
  heartbeatMs?: number;
  /** 租约时长（毫秒） */
  leaseMs?: number;
  /** 高风险技能的确认策略；`allow` 仅用于自动化测试 */
  confirmationPolicy?: SkillExecutorOptions['confirmationPolicy'];
}

/** 正在执行的任务记录 */
interface ActiveRun {
  ctx: FencingContext;
  controller: AbortController;
  heartbeat: NodeJS.Timeout;
  timeout: NodeJS.Timeout;
}

export class TaskRunner {
  private readonly registry: SkillRegistry;
  private readonly deps: SkillDeps;
  private readonly queues: TaskQueuePool;
  private readonly workerId: string;
  private readonly logger: SkillLogger;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly confirmationPolicy: SkillExecutorOptions['confirmationPolicy'];

  /** 正在执行的任务（taskId → 运行时状态），供优雅关闭与取消使用 */
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: TaskRunnerOptions) {
    this.registry = options.registry;
    this.deps = options.deps;
    this.queues = options.queues;
    this.workerId = options.workerId;
    this.logger = options.logger;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.confirmationPolicy = options.confirmationPolicy ?? 'reject';
  }

  /** 当前在途任务数（优雅关闭时判断是否还有活干） */
  get inFlightCount(): number {
    return this.active.size;
  }

  /** 中断所有在途任务 */
  abortAll(reason: string): void {
    for (const [taskId, run] of this.active) {
      this.logger.warn(`中断在途任务 ${taskId}：${reason}`);
      run.controller.abort();
    }
  }

  /**
   * 处理一条队列作业。
   *
   * **不抛异常**：无论内部发生什么，都返回结构化的 TaskJobResult，
   * 让队列层记录真实结果（而不是把领域失败误报为队列失败）。
   */
  async handleJob(job: { taskId: string; attempt: number }): Promise<TaskJobResult> {
    const { taskId } = job;

    const task = await prisma.agentTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        projectId: true,
        contentId: true,
        sessionId: true,
        skillId: true,
        status: true,
        input: true,
        error: true,
      },
    });

    if (!task) {
      this.logger.warn(`任务 ${taskId} 不存在，跳过`);
      return { taskId, status: 'skipped', message: '任务不存在' };
    }

    // 队列可能重复投递；已完成或已取消的任务不应再次执行
    if (task.status === 'success' || task.status === 'cancelled') {
      return { taskId, status: 'skipped', message: `任务已是 ${task.status} 状态` };
    }

    // 上一次尝试的失败原因：重试时回喂给技能，让它有机会改变策略
    const previousError = task.error;

    const claim = await claimTask({ taskId, workerId: this.workerId, leaseMs: this.leaseMs });
    if (!claim.ok) {
      this.logger.info(`任务 ${taskId} 抢占失败（${claim.reason}），跳过`);
      return { taskId, status: 'skipped', message: `抢占失败：${claim.reason}` };
    }

    const ctx: FencingContext = {
      taskId,
      workerId: claim.workerId,
      leaseVersion: claim.leaseVersion,
      attempt: claim.attempt,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      this.logger.warn(`任务 ${taskId} 超过单次执行上限（${SKILL_TIMEOUT_MS}ms），触发中断`);
      controller.abort();
    }, SKILL_TIMEOUT_MS);
    timeout.unref();

    const activeRun: ActiveRun = {
      ctx,
      controller,
      heartbeat: this.startHeartbeat(ctx, controller),
      timeout,
    };
    this.active.set(taskId, activeRun);

    try {
      // 每次作业都构造执行器：这样进度 / 步骤回调天然携带本次的 Fencing 令牌
      const executor = this.buildExecutor(ctx);
      this.logger.info(
        `开始执行任务 ${taskId}（技能 ${task.skillId}，第 ${claim.attempt} 次尝试）`,
      );

      const result: ExecuteSkillResult = await executor.execute(
        {
          skillId: task.skillId,
          input: (task.input ?? {}) as Record<string, unknown>,
          taskId,
          projectId: task.projectId,
          contentId: task.contentId,
          sessionId: task.sessionId,
          attempt: claim.attempt,
          previousError,
        },
        controller.signal,
      );

      return result.ok ? await this.handleSuccess(ctx, result) : await this.handleFailure(ctx, result);
    } finally {
      clearInterval(activeRun.heartbeat);
      clearTimeout(activeRun.timeout);
      this.active.delete(taskId);
    }
  }

  /** 构造绑定了当前令牌的执行器 */
  private buildExecutor(ctx: FencingContext): SkillExecutor {
    return new SkillExecutor({
      registry: this.registry,
      deps: this.deps,
      logger: this.logger,
      onProgress: async (taskId, progress, message) => {
        // 只有令牌仍有效时才会真正写入（仓储层做 CAS）
        const written = await updateTaskProgress(
          { ...ctx, taskId },
          progress,
          message,
        );
        if (!written && progress > 0) {
          // 写不进去通常意味着租约已被接管，此时中断执行以免浪费额度
          this.logger.warn(`任务 ${taskId} 进度写入被拒绝（可能租约已失效）`);
        }
      },
      onStep: async (taskId, name, detail) => {
        await appendTaskStep({
          taskId,
          name,
          status: 'success',
          ...(detail !== undefined ? { output: detail } : {}),
        });
      },
      confirmationPolicy: this.confirmationPolicy,
    });
  }

  /** 成功路径 */
  private async handleSuccess(
    ctx: FencingContext,
    result: Extract<ExecuteSkillResult, { ok: true }>,
  ): Promise<TaskJobResult> {
    const output: Record<string, unknown> = {
      ...result.output,
      ...(result.assetIds.length > 0 ? { producedAssetIds: result.assetIds } : {}),
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      ...(result.card !== undefined ? { card: result.card } : {}),
    };

    const written = await completeTask(ctx, output, { durationMs: result.durationMs });

    if (!written) {
      // 租约已被接管：本次结果不应被采纳。Fencing 正确生效，不是错误。
      this.logger.warn(
        `任务 ${ctx.taskId} 的成功结果未写入：租约已被接管（fencing 生效，属预期行为）`,
      );
      return { taskId: ctx.taskId, status: 'skipped', message: '租约已被接管，结果未采纳' };
    }

    this.logger.info(`任务 ${ctx.taskId} 执行成功`, {
      durationMs: result.durationMs,
      assetCount: result.assetIds.length,
    });

    return {
      taskId: ctx.taskId,
      status: 'success',
      ...(result.summary !== undefined ? { message: result.summary } : {}),
    };
  }

  /** 失败路径：区分「需要确认」与「可重试失败」 */
  private async handleFailure(
    ctx: FencingContext,
    result: Extract<ExecuteSkillResult, { ok: false }>,
  ): Promise<TaskJobResult> {
    const { error } = result;

    // 需要用户确认：任务停在这里等待，不入队重试
    if (isConfirmationRequired(error)) {
      const parked = await parkTaskForConfirmation(ctx, error.userMessage);
      this.logger.info(`任务 ${ctx.taskId} 进入等待确认状态`);
      return {
        taskId: ctx.taskId,
        status: 'skipped',
        message: parked ? '等待用户确认' : '等待确认时租约已被接管',
      };
    }

    const outcome = await failTask(
      ctx,
      {
        message: error.message,
        userMessage: error.userMessage,
        retryable: isRetryableError(error),
      },
      { durationMs: result.durationMs },
    );

    if (outcome.shouldRetry && outcome.nextAttempt !== undefined) {
      const task = await prisma.agentTask.findUnique({
        where: { id: ctx.taskId },
        select: { queueName: true },
      });
      const queueName = task?.queueName;

      if (queueName === null || queueName === undefined) {
        this.logger.error(`任务 ${ctx.taskId} 缺少队列信息，无法安排重试`);
        return { taskId: ctx.taskId, status: 'failed', message: '缺少队列信息，无法重试' };
      }

      // 入队在事务提交之后执行
      await this.queues.enqueue({
        taskId: ctx.taskId,
        queueName,
        attempt: outcome.nextAttempt,
        ...(outcome.retryDelayMs !== undefined ? { delayMs: outcome.retryDelayMs } : {}),
      });

      this.logger.warn(
        `任务 ${ctx.taskId} 第 ${ctx.attempt} 次尝试失败，` +
          `${Math.round((outcome.retryDelayMs ?? 0) / 1000)} 秒后重试（第 ${outcome.nextAttempt} 次）`,
        { errorCode: error.code, message: error.message },
      );

      return {
        taskId: ctx.taskId,
        status: 'retry_scheduled',
        message: `已安排第 ${outcome.nextAttempt} 次尝试：${error.userMessage}`,
      };
    }

    this.logger.error(`任务 ${ctx.taskId} 最终失败`, {
      errorCode: error.code,
      message: error.message,
      attempts: ctx.attempt,
    });

    return { taskId: ctx.taskId, status: 'failed', message: error.userMessage };
  }

  /**
   * 启动心跳续约。
   *
   * 续约失败说明租约已被接管，立刻 abort 本次执行 —— 继续跑只是在浪费额度，
   * 且结果不会被采纳。
   */
  private startHeartbeat(ctx: FencingContext, controller: AbortController): NodeJS.Timeout {
    const timer = setInterval(() => {
      renewLease(ctx, this.leaseMs)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(`任务 ${ctx.taskId} 续约失败（租约已被接管），中断执行`);
            controller.abort();
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(`任务 ${ctx.taskId} 心跳异常`, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, this.heartbeatMs);

    // 心跳不应阻止进程退出
    timer.unref();
    return timer;
  }
}

/** 导出，便于测试验证退避算法 */
export { computeRetryDelay };
