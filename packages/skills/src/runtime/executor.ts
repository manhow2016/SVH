/**
 * Skill Executor —— 技能执行引擎
 *
 * 职责边界：
 * - **它不做**幂等、租约、状态机（那是 @svh/database 任务仓储与 Worker 的事）
 * - **它做**：解析技能 → 权限检查 → 装配执行上下文 → 调用实现 →
 *   包裹错误为可重试/不可重试 → 收集产出
 *
 * 之所以把「上下文装配」独立出来，是因为 Skill 实现只应关心业务，
 * 不应该知道任务是第几次尝试、进度怎么上报、日志往哪写。
 */
import {
  ConfirmationRequiredError,
  isSvhError,
  SkillNotFoundError,
  toSvhError,
  ValidationError,
  type SvhError,
} from '@svh/domain';

import type { SkillDeps, SkillExecutionContext, SkillLogger, SkillModelPort } from './ports.js';
import type { SkillExecutionOutput, SkillRegistry } from './registry.js';

/** 执行请求 */
export interface ExecuteSkillRequest {
  skillId: string;
  /** 自由形态输入，由技能自己的 normalizeInput 收敛 */
  input: Record<string, unknown>;
  taskId: string;
  projectId: string;
  contentId?: string | null;
  sessionId?: string | null;
  attempt: number;
  /** 上一次尝试的失败原因（重试时回喂） */
  previousError?: string | null;
  /** 用户会员等级，用于权限检查；不传表示内部任务 */
  tier?: 'free' | 'pro' | 'enterprise';
}

/** 执行结果（成功） */
export interface ExecuteSkillSuccess {
  ok: true;
  output: Record<string, unknown>;
  assetIds: string[];
  summary?: string;
  card?: Record<string, unknown>;
  durationMs: number;
}

/** 执行结果（失败） */
export interface ExecuteSkillFailure {
  ok: false;
  error: SvhError;
  durationMs: number;
}

export type ExecuteSkillResult = ExecuteSkillSuccess | ExecuteSkillFailure;

/** Executor 依赖：注册表 + 端口 + 基础设施回调 */
export interface SkillExecutorOptions {
  registry: SkillRegistry;
  deps: SkillDeps;
  logger?: SkillLogger;
  /** 进度上报回调（由 Worker 接到任务仓储） */
  onProgress?: (taskId: string, progress: number, message?: string) => Promise<void>;
  /** 子步骤记录回调 */
  onStep?: (taskId: string, name: string, detail?: Record<string, unknown>) => Promise<void>;
  /**
   * 高风险技能的确认策略。
   * - `reject`（默认）：抛 ConfirmationRequiredError，由 Worker 将任务置为 waiting_user
   * - `allow`：跳过确认直接执行（用于自动化测试与已获授权的批处理）
   */
  confirmationPolicy?: 'reject' | 'allow';
}

/** 空日志器，避免每个调用点都做非空判断 */
const NOOP_LOGGER: SkillLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class SkillExecutor {
  private readonly registry: SkillRegistry;
  private readonly deps: SkillDeps;
  private readonly logger: SkillLogger;
  private readonly onProgress: SkillExecutorOptions['onProgress'];
  private readonly onStep: SkillExecutorOptions['onStep'];
  private readonly confirmationPolicy: 'reject' | 'allow';

  constructor(options: SkillExecutorOptions) {
    this.registry = options.registry;
    this.deps = options.deps;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.onProgress = options.onProgress;
    this.onStep = options.onStep;
    this.confirmationPolicy = options.confirmationPolicy ?? 'reject';
  }

  /**
   * 执行一个技能。
   *
   * **不抛异常**：所有失败都被归一化为 `SvhError` 并放在返回值里。
   * 原因：调用方（Worker）需要对失败做分支处理（重试 / 终止 / 等待确认），
   * 用返回值比 try/catch 更能强制调用方处理每种情况。
   */
  async execute(request: ExecuteSkillRequest, signal: AbortSignal): Promise<ExecuteSkillResult> {
    const startedAt = Date.now();

    try {
      const { definition, implementation } = this.registry.resolve(request.skillId);

      // ── 权限检查（技术文档第 68 条） ──
      this.registry.assertAccess(request.skillId, { tier: request.tier });

      // ── 高风险技能的确认闸门（技术文档第 47 条） ──
      // 判定来源有两个：
      //   1. 静态声明：definition.requiresConfirmation（技能天然高成本）
      //   2. 动态判定：implementation.isHighRisk(input)（成本随本次规模变化）
      // 前者在归一化之前就能判断，后者需要归一化后的输入，
      // 因此两者分别检查，只要有任意一个为真就要求确认。
      const staticallyRisky = definition.requiresConfirmation;

      // ── 输入归一化：把自由 JSON 收敛为强类型输入 ──
      const normalized =
        implementation.normalizeInput !== undefined
          ? implementation.normalizeInput(request.input)
          : (request.input as never);

      const dynamicallyRisky = implementation.isHighRisk?.(normalized) ?? false;

      if ((staticallyRisky || dynamicallyRisky) && this.confirmationPolicy === 'reject') {
        throw new ConfirmationRequiredError(
          `技能 ${request.skillId} 属于高成本操作，需要用户确认`,
          {
            context: {
              skillId: request.skillId,
              risk: definition.risk,
              dynamic: dynamicallyRisky,
            },
            userMessage: dynamicallyRisky
              ? `「${definition.name}」本次的规模较大，需要你确认后才会执行。`
              : `「${definition.name}」属于高成本操作，需要你确认后才会执行。`,
            suggestions: ['确认后执行', '减少本次生成数量'],
          },
        );
      }

      const ctx = this.buildContext(request, signal);

      this.logger.info(`开始执行技能 ${request.skillId}`, {
        taskId: request.taskId,
        attempt: request.attempt,
      });

      const result: SkillExecutionOutput = await implementation.execute(normalized, ctx);

      return {
        ok: true,
        output: result.output,
        assetIds: result.assetIds ?? [],
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        ...(result.card !== undefined ? { card: result.card } : {}),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const error = toSvhError(err);
      this.logger.warn(`技能 ${request.skillId} 执行失败：${error.code}`, {
        taskId: request.taskId,
        message: error.message,
      });
      return { ok: false, error, durationMs: Date.now() - startedAt };
    }
  }

  /**
   * 把模型端口包装为「已绑定任务上下文」的端口。
   *
   * 为什么在这里做而不是让每个技能自己传：技能实现只关心业务，
   * 让它每次都手写 `taskId` 既啰嗦又容易漏。执行器是唯一知道
   * 「当前是哪个任务」的地方，因此在这里统一绑定 ——
   * 15 个技能实现一行都不用改就获得了成本归因能力。
   */
  private bindModelPort(request: ExecuteSkillRequest, base: SkillModelPort): SkillModelPort {
    const taskId = request.taskId;
    const projectId = request.projectId;
    const contentId = request.contentId ?? null;
    const skillId = request.skillId;

    return {
      listModels: () => base.listModels(),
      invoke: (modelRequest, extra) =>
        base.invoke(modelRequest, {
          taskId,
          skillId,
          projectId,
          contentId,
          ...(extra ?? {}),
        }),
    };
  }

  /** 装配执行上下文 */
  private buildContext(request: ExecuteSkillRequest, signal: AbortSignal): SkillExecutionContext {
    const progressEnabled = this.onProgress !== undefined;
    const stepEnabled = this.onStep !== undefined;

    // deps 是只读模板；这里产出一份带绑定模型端口的新对象，
    // 避免修改共享的 deps 影响其它并发任务。
    const deps: SkillDeps = { ...this.deps, models: this.bindModelPort(request, this.deps.models) };

    return {
      taskId: request.taskId,
      projectId: request.projectId,
      contentId: request.contentId ?? null,
      sessionId: request.sessionId ?? null,
      attempt: request.attempt,
      previousError: request.previousError ?? null,
      deps,
      logger: this.logger,
      signal,
      reportProgress: async (progress, message) => {
        if (!progressEnabled) return;
        await this.onProgress?.(request.taskId, progress, message);
      },
      step: async (name, detail) => {
        if (!stepEnabled) return;
        await this.onStep?.(request.taskId, name, detail);
      },
    };
  }
}

/**
 * 判断错误是否应当触发重试。
 *
 * 规则：
 * - 不可重试：参数校验失败、技能未实现、权限不足、需要确认
 *   —— 这些重试多少次结果都一样
 * - 可重试：模型/Provider 类错误、任务超时、内部错误
 */
export function isRetryableError(error: SvhError): boolean {
  if (error instanceof ValidationError) return false;
  if (error instanceof SkillNotFoundError) return false;
  switch (error.code) {
    case 'VALIDATION_FAILED':
    case 'SKILL_NOT_FOUND':
    case 'SKILL_TIER_REQUIRED':
    case 'CONFIRMATION_REQUIRED':
    case 'FORBIDDEN':
    case 'UNAUTHORIZED':
    case 'NOT_FOUND':
    case 'ASSET_NOT_FOUND':
    case 'CONTENT_NOT_FOUND':
      return false;
    default:
      return error.retryable;
  }
}

/** 判断是否为「需要用户确认」这一类特殊失败 */
export function isConfirmationRequired(error: SvhError): boolean {
  return error.code === 'CONFIRMATION_REQUIRED';
}

/** 判断错误是否可直接判定任务失败（无需再试） */
export function isFatalError(error: unknown): boolean {
  return isSvhError(error) && error.code === 'VALIDATION_FAILED';
}
