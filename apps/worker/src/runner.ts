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
 *
 * ── 事件广播是「尽力而为」──
 * 状态跃迁与进度**落库之后**经 EventSink 广播（见 events.ts）。
 * emit 是同步的、发射后不管的：EventSink 的会话归属也来自调用栈上的
 * `task.sessionId`，不额外查库。Redis 抖动绝不能让任务执行变慢或失败。
 *
 * 广播的另一半是「只播本次执行确实拥有的发言权」：进度与成功看仓储层返回的
 * `written`，等待确认看 `parked`，失败路径看 `failTask` 的 `written`
 * （它直接反映「这次失败状态是否真的落库」，见 `FailResult`）。
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
  type FailResult,
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

import { NOOP_EVENT_SINK, type EventSink } from './events.js';

/** 单次技能执行的最长时间，超过则主动中断，避免占死 Worker 并发槽位 */
const SKILL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 失败路径最终落到数据库里的任务状态。
 *
 * `failTask` 只会写 `pending`（还能重试）或 `failed`（终态）；
 * `cancelled` 不在这里 —— 那是用户主动取消（API 的 `cancelTask`）产生的状态。
 * 事件必须与数据库的真实状态一致，否则前端刷新后会出现状态跳变。
 */
function statusAfterFail(outcome: FailResult): 'pending' | 'failed' {
  return outcome.shouldRetry ? 'pending' : 'failed';
}

export interface TaskRunnerOptions {
  registry: SkillRegistry;
  deps: SkillDeps;
  queues: TaskQueuePool;
  workerId: string;
  logger: SkillLogger;
  /** 事件汇聚器；未注入时不推送（测试与脚本场景） */
  events?: EventSink;
  /** 心跳间隔（毫秒） */
  heartbeatMs?: number;
  /** 租约时长（毫秒） */
  leaseMs?: number;
  /** 高风险技能的确认策略；`allow` 仅用于自动化测试 */
  confirmationPolicy?: SkillExecutorOptions['confirmationPolicy'];
}

/**
 * 本次执行的租约有效性标记。
 *
 * 心跳续约失败（`renewLease` 命中 0 行）是「租约已被接管 / 任务已被取消」的
 * **确定信号**：此后本次执行对任务状态没有发言权，心跳据此立刻中断执行。
 *
 * 事件广播**不**直接读这个标记：`failTask` 返回的 `written` 更精确 —— 它反映
 * 「这次失败状态是否真的写进了库」，而 CAS 落空的原因不止续约失败一种
 * （用户取消会同时改状态并删租约，心跳还没轮到，`lost` 仍是 false）。
 * 本标记保留用于中断执行，以及区分「未写入」的原因（见 handleFailure 的日志）。
 */
interface LeaseState {
  lost: boolean;
}

/** 正在执行的任务记录 */
interface ActiveRun {
  ctx: FencingContext;
  controller: AbortController;
  /**
   * 租约有效性标记：**只由心跳写入**，读取方是执行中断判断与失败日志
   * （区分「未写入」的原因）。事件广播**不**读它，而是看仓储层返回的
   * `written` —— 续约失败并非「状态未写入」的唯一原因（见上方说明）。
   */
  lease: LeaseState;
  heartbeat: NodeJS.Timeout;
  timeout: NodeJS.Timeout;
}

export class TaskRunner {
  private readonly registry: SkillRegistry;
  /** 依赖可被替换（配置热更新），因此不是 readonly */
  private deps: SkillDeps;
  private readonly queues: TaskQueuePool;
  private readonly workerId: string;
  private readonly logger: SkillLogger;
  private readonly events: EventSink;
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
    this.events = options.events ?? NOOP_EVENT_SINK;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.confirmationPolicy = options.confirmationPolicy ?? 'reject';
  }

  /** 当前在途任务数（优雅关闭时判断是否还有活干） */
  get inFlightCount(): number {
    return this.active.size;
  }

  /**
   * 就地替换 Skill 依赖（模型服务配置变更后调用）。
   *
   * 只影响**之后新建**的执行器：正在执行的任务继续用旧依赖跑完，
   * 避免中途换模型导致同一次生成的前后步骤风格不一致。
   */
  replaceDeps(deps: SkillDeps): void {
    this.deps = deps;
    this.logger.info('技能依赖已更新（新任务将使用最新模型配置）');
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

    // 抢占成功即进入执行态，立刻广播，使用户看到任务从排队变为运行中
    this.events.emit({
      sessionId: task.sessionId,
      type: 'task.status',
      data: { taskId, status: 'running', attempt: claim.attempt },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      this.logger.warn(`任务 ${taskId} 超过单次执行上限（${SKILL_TIMEOUT_MS}ms），触发中断`);
      controller.abort();
    }, SKILL_TIMEOUT_MS);
    timeout.unref();

    // 心跳与失败路径共享同一个标记对象：心跳写、广播前读
    const lease: LeaseState = { lost: false };

    const activeRun: ActiveRun = {
      ctx,
      controller,
      lease,
      heartbeat: this.startHeartbeat(ctx, controller, lease),
      timeout,
    };
    this.active.set(taskId, activeRun);

    try {
      // 每次作业都构造执行器：这样进度 / 步骤回调天然携带本次的 Fencing 令牌
      const executor = this.buildExecutor(ctx, task.sessionId);
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

      return result.ok
        ? await this.handleSuccess(ctx, task.sessionId, result)
        : await this.handleFailure(ctx, task.sessionId, result, activeRun.lease);
    } finally {
      clearInterval(activeRun.heartbeat);
      clearTimeout(activeRun.timeout);
      this.active.delete(taskId);
    }
  }

  /**
   * 构造绑定了当前令牌的执行器。
   *
   * `sessionId` 由调用处从 `task.sessionId` 传进来：进度回调的签名里没有它，
   * 但事件必须带会话归属 —— 用闭包捕获调用栈上已有的值，不为此再查一次库。
   */
  private buildExecutor(ctx: FencingContext, sessionId: string | null): SkillExecutor {
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
        // 只广播真正落库的进度：前端进度条不能出现数据库里没有的中间态
        if (written) {
          this.events.emit({
            sessionId,
            type: 'task.progress',
            data: { taskId, progress, message: message ?? null },
          });
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
    sessionId: string | null,
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

    // 只广播真正写入数据库的结果：结果未被采纳时不能告诉用户「已完成」
    this.events.emit({
      sessionId,
      type: 'task.status',
      data: { taskId: ctx.taskId, status: 'success', assetCount: result.assetIds.length },
    });

    // 每个产出资产各广播一条，使用户的资产列表无需刷新即可更新
    for (const assetId of result.assetIds) {
      this.events.emit({
        sessionId,
        type: 'asset.changed',
        data: { assetId, taskId: ctx.taskId, change: 'created' },
      });
    }

    return {
      taskId: ctx.taskId,
      status: 'success',
      ...(result.summary !== undefined ? { message: result.summary } : {}),
    };
  }

  /** 失败路径：区分「需要确认」与「可重试失败」 */
  private async handleFailure(
    ctx: FencingContext,
    sessionId: string | null,
    result: Extract<ExecuteSkillResult, { ok: false }>,
    lease: LeaseState,
  ): Promise<TaskJobResult> {
    const { error } = result;

    // 需要用户确认：任务停在这里等待，不入队重试
    if (isConfirmationRequired(error)) {
      const parked = await parkTaskForConfirmation(ctx, error.userMessage);
      this.logger.info(`任务 ${ctx.taskId} 进入等待确认状态`);
      // 只有真的停下等待才广播：写入被拒说明租约已被接管，任务并不在等这个用户确认
      if (parked) {
        this.events.emit({
          sessionId,
          type: 'task.status',
          data: { taskId: ctx.taskId, status: 'waiting_user', message: error.userMessage },
        });
      }
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
        // failTask 已把任务写回 pending，事件按数据库的真实状态广播，
        // 否则前端会停在「运行中」，刷新后又变成「排队中」。
        // 但没写进库时例外：那次 CAS 什么都没改，广播必然与库不一致（见 written）
        if (outcome.written) {
          this.events.emit({
            sessionId,
            type: 'task.status',
            data: {
              taskId: ctx.taskId,
              status: statusAfterFail(outcome),
              message: error.userMessage,
            },
          });
        }
        return { taskId: ctx.taskId, status: 'failed', message: '缺少队列信息，无法重试' };
      }

      // 状态没写进库说明这次失败不属于本次执行：租约已被接管，或任务已被用户取消。
      // 此时既不能入队重试（只会换来一次注定被跳过的出队），也不能广播 ——
      // 库里可能是 cancelled，播 pending 会把前端永久留在错误状态。
      if (!outcome.written) {
        this.logger.warn(
          `任务 ${ctx.taskId} 的失败状态未写入（${
            lease.lost ? '租约已被接管' : '任务已被取消或状态已变化'
          }），不安排重试、不广播状态`,
        );
        return { taskId: ctx.taskId, status: 'skipped', message: '失败状态未写入，未安排重试' };
      }

      // 入队在事务提交之后执行
      await this.queues.enqueue({
        taskId: ctx.taskId,
        queueName,
        attempt: outcome.nextAttempt,
        ...(outcome.retryDelayMs !== undefined ? { delayMs: outcome.retryDelayMs } : {}),
      });

      // 作业已真的入队，此时广播「退回排队」才是准确的（written 已为 true）
      this.events.emit({
        sessionId,
        type: 'task.status',
        data: {
          taskId: ctx.taskId,
          status: statusAfterFail(outcome),
          message: error.userMessage,
        },
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

    // 同上：没写进库时 failTask 什么都没改，广播 failed 会与数据库（可能是 cancelled）冲突
    if (outcome.written) {
      this.events.emit({
        sessionId,
        type: 'task.status',
        data: { taskId: ctx.taskId, status: statusAfterFail(outcome), message: error.userMessage },
      });
    }

    return { taskId: ctx.taskId, status: 'failed', message: error.userMessage };
  }

  /**
   * 启动心跳续约。
   *
   * 续约失败说明租约已被接管，立刻 abort 本次执行 —— 继续跑只是在浪费额度，
   * 且结果不会被采纳。
   *
   * 同时把「租约已失效」写进共享的 `lease` 标记，供失败路径区分「未写入」的
   * 原因（见 `LeaseState` 与 handleFailure 的日志）。写入必须发生在 `abort()`
   * **之前**：技能正是靠 abort 才会尽快抛错，抛错后读到的就必须已经是这个标记。
   */
  private startHeartbeat(
    ctx: FencingContext,
    controller: AbortController,
    lease: LeaseState,
  ): NodeJS.Timeout {
    const timer = setInterval(() => {
      renewLease(ctx, this.leaseMs)
        .then((renewed) => {
          if (!renewed) {
            lease.lost = true;
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
