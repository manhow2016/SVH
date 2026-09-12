/**
 * Model Router
 *
 * 落实技术文档第 29、67 条：
 *   Skill → Model Router → Provider → Model
 *
 * 三条职责，且只做这三件事：
 *   1. **选模**：按策略（质量 / 成本 / 速度 / 手动）从候选集中排序
 *   2. **重试**：单模型内指数退避重试
 *   3. **降级**：模型耗尽重试后切换下一个候选模型，并记录降级链路
 *
 * 不做的事：协议转换（交给适配器）、持久化（交给 recorder）、
 * 密钥管理（交给 SecretResolver）。
 */
import {
  isSvhError,
  ModelNotConfiguredError,
  ModelTimeoutError,
  PROVIDER_FAILURE_CODES,
  ProviderUnavailableError,
  toSvhError,
  type ModelCapability,
  type ModelInvokeRequest,
  type ModelInvokeResult,
  type ModelRoutingPolicy,
  type ProviderHealth,
} from '@svh/domain';

import type {
  ModelCallContext,
  ModelDescriptor,
  ModelRouterOptions,
  ProviderAdapter,
  ProviderDescriptor,
  RoutingDecision,
} from './ports.js';

/**
 * 默认路由策略。
 *
 * 刻意**不加 `as const`**：加了会把 `strategy` 收窄成字面量 `'quality'`，
 * 使 `{ ...DEFAULT_POLICY, ...override }` 的合并结果与策略类型不兼容。
 */
const DEFAULT_POLICY = {
  strategy: 'quality',
  maxRetries: 2,
  allowFallback: true,
  maxFallbacks: 3,
  timeoutMs: 300_000,
  backoffMs: 1000,
  allowSharedProviders: true,
} satisfies Omit<ModelRoutingPolicy, 'modelId' | 'maxCost'>;

/** 补全后的路由策略：默认策略保证必填项齐全，调用方只覆盖它关心的字段 */
type ResolvedPolicy = ModelRoutingPolicy;

/** 健康状态对排序的影响：down 直接排除，degraded 降权 */
const HEALTH_PENALTY: Record<ProviderHealth, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  down: Number.POSITIVE_INFINITY,
};

/** 带超时的 sleep，可被外部 signal 打断 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 判断错误是否值得换一个模型重试（而不是同一模型重试） */
function isModelScopedFailure(err: unknown): boolean {
  if (!isSvhError(err)) return true;
  // 这几类错误换模型更可能成功：服务不可用、限流、超时、返回内容不合法
  return (
    err.code === 'PROVIDER_UNAVAILABLE' ||
    err.code === 'MODEL_RATE_LIMITED' ||
    err.code === 'MODEL_TIMEOUT' ||
    err.code === 'MODEL_BAD_OUTPUT' ||
    PROVIDER_FAILURE_CODES.includes(err.code)
  );
}

export class ModelRouter {
  private readonly providers: Map<string, ProviderDescriptor>;
  private readonly models: ModelDescriptor[];
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly resolveSecret: ModelRouterOptions['resolveSecret'];
  private readonly recordCall: ModelRouterOptions['recordCall'];
  private readonly logger: ModelRouterOptions['logger'];

  /** 适配器实例缓存：审计结论 ⑨ 要求避免每次调用都重建适配器 */
  constructor(options: ModelRouterOptions) {
    // 显式标注泛型：`new Map(arr.map(...))` 会把值推断为 any，
    // 使后续 this.providers.get() 的返回值失去类型，触发 no-unsafe-assignment。
    this.providers = new Map<string, ProviderDescriptor>(
      options.providers.map((p): [string, ProviderDescriptor] => [p.providerId, p]),
    );
    this.models = options.models;
    this.adapters = new Map<string, ProviderAdapter>(
      options.adapters.map((a): [string, ProviderAdapter] => [a.kind, a]),
    );
    this.resolveSecret = options.resolveSecret;
    this.recordCall = options.recordCall;
    this.logger = options.logger;
  }

  /**
   * 补充注册适配器。
   *
   * 已存在的协议不会被覆盖 —— 这让「先注册真实适配器、再补 Mock 兜底」
   * 的顺序安全：真实 Provider 永远优先，Mock 只在没有真实适配器时才生效。
   *
   * @returns 实际新增的协议列表（便于启动日志确认装配结果）
   */
  registerAdapters(adapters: readonly ProviderAdapter[]): string[] {
    const added: string[] = [];
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) continue;
      this.adapters.set(adapter.kind, adapter);
      added.push(adapter.kind);
    }
    return added;
  }

  /** 当前已注册的协议列表（供健康检查与诊断） */
  listAdapterKinds(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * 按能力挑选候选模型并排序。
   *
   * 排序规则：
   * - 排除 `enabled = false` 与 Provider `health = down` 的模型
   * - 按策略排序（quality 看 priority、cost 看 unitCost、speed 看 priority 代理）
   * - degraded 的 Provider 追加惩罚，排在健康 Provider 之后
   */
  selectCandidates(
    capability: ModelCapability,
    policy: ResolvedPolicy,
  ): { candidates: ModelDescriptor[]; decision: RoutingDecision } {
    const decision: RoutingDecision = { capability, strategy: policy.strategy, candidates: [] };

    // 手动指定模型：只尝试它一个（但必须先满足能力要求）
    if (policy.strategy === 'manual') {
      const manual = this.models.find((m) => m.modelId === policy.modelId);
      if (!manual) {
        throw new ModelNotConfiguredError(`指定的模型 ${policy.modelId ?? '(未指定)'} 不存在`, {
          context: { capability, modelId: policy.modelId },
        });
      }
      if (!manual.capabilities.includes(capability)) {
        throw new ModelNotConfiguredError(
          `模型 ${manual.displayName} 不支持「${capability}」能力`,
          { context: { capability, modelId: manual.modelId } },
        );
      }
      decision.candidates.push({
        modelId: manual.modelId,
        providerId: manual.providerId,
        reason: '用户手动指定',
      });
      decision.chosen = { modelId: manual.modelId, providerId: manual.providerId };
      return { candidates: [manual], decision };
    }

    const eligible = this.models.filter((m) => {
      if (!m.enabled) return false;
      if (!m.capabilities.includes(capability)) return false;
      const provider = this.providers.get(m.providerId);
      if (!provider || !provider.enabled) return false;
      if (m.providerHealth === 'down') return false;
      return true;
    });

    const score = (m: ModelDescriptor): number[] => {
      const penalty = HEALTH_PENALTY[m.providerHealth];
      switch (policy.strategy) {
        case 'cost': {
          const cost = m.unitCost !== null && m.unitCost !== undefined ? Number.parseFloat(m.unitCost) : Number.POSITIVE_INFINITY;
          return [penalty, Number.isFinite(cost) ? cost : Number.MAX_SAFE_INTEGER, -m.priority];
        }
        case 'speed':
          // 无实测延迟数据时以 priority 作为代理（约定高优先级 = 更快通道）
          return [penalty, -m.priority];
        case 'quality':
        default:
          return [penalty, -m.priority];
      }
    };

    const sorted = [...eligible].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
        const diff = (sa[i] ?? 0) - (sb[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return a.modelId.localeCompare(b.modelId);
    });

    for (const model of sorted) {
      decision.candidates.push({
        modelId: model.modelId,
        providerId: model.providerId,
        reason: `priority=${model.priority} health=${model.providerHealth}`,
      });
    }
    if (sorted[0]) {
      decision.chosen = { modelId: sorted[0].modelId, providerId: sorted[0].providerId };
    }

    return { candidates: sorted, decision };
  }

  /**
   * 执行一次模型调用（含重试与降级）。
   *
   * @param context 业务上下文（taskId / skillId 等），仅用于调用记录与归因，
   *                不参与选模决策
   * @throws {ModelNotConfiguredError} 没有任何可用候选模型
   * @throws {ProviderUnavailableError} 全部候选都失败
   */
  async invoke(
    request: ModelInvokeRequest,
    context: ModelCallContext = {},
  ): Promise<ModelInvokeResult> {
    const policy: ResolvedPolicy = { ...DEFAULT_POLICY, ...(request.routing ?? {}) };
    const { candidates, decision } = this.selectCandidates(request.capability, policy);

    if (candidates.length === 0) {
      // 区分两种完全不同的原因：一种要用户去配置，另一种要用户去修故障。
      // 早期实现统一报「没有配置模型」，当模型其实存在、只是 Provider 被标记为
      // 不可用时报错信息会严重误导用户。
      const unhealthy = this.models.filter(
        (m) => m.capabilities.includes(request.capability) && m.enabled && m.providerHealth !== 'healthy',
      );

      if (unhealthy.length > 0) {
        const names = [...new Set(unhealthy.map((m) => m.providerName))].join('、');
        throw new ModelNotConfiguredError(
          `「${request.capability}」能力的模型当前不可用：${names} 被标记为异常状态`,
          {
            context: {
              capability: request.capability,
              unhealthyProviders: names,
            },
            userMessage: '当前模型服务不可用，请在设置中检查服务状态或更换模型。',
            suggestions: ['在设置中执行连通性测试', '更换其它模型服务商'],
          },
        );
      }

      throw new ModelNotConfiguredError(
        `没有可用于「${request.capability}」能力的模型，请先在设置中配置模型 API。`,
        { context: { capability: request.capability } },
      );
    }

    // 降级次数上限：maxFallbacks + 1 个模型
    const chain = candidates.slice(0, Math.max(1, policy.maxFallbacks + 1));

    // 先筛出「协议有适配器」的候选。
    // 若一个都不剩，说明是**配置问题**（缺少对应协议的适配器）而不是
    // 服务商故障 —— 必须报 MODEL_NOT_CONFIGURED 并说清原因，
    // 否则用户会看到「模型服务暂时不可用」这种误导性的提示，
    // 而实际上重试一万次也不会成功。
    const runnable: Array<{ model: ModelDescriptor; provider: ProviderDescriptor; adapter: ProviderAdapter }> = [];
    const missingProtocols = new Set<string>();

    for (const model of chain) {
      const provider = this.providers.get(model.providerId);
      if (!provider) continue;
      const adapter = this.adapters.get(provider.kind);
      if (!adapter) {
        missingProtocols.add(provider.kind);
        this.logger?.warn(
          `没有 ${String(provider.kind)} 协议的适配器，跳过模型 ${model.displayName}`,
        );
        continue;
      }
      runnable.push({ model, provider, adapter });
    }

    if (runnable.length === 0 && missingProtocols.size > 0) {
      const kinds = [...missingProtocols].join('、');
      throw new ModelNotConfiguredError(
        `没有可用于「${request.capability}」能力的模型：已配置的 Provider 协议（${kinds}）缺少对应适配器`,
        {
          context: { capability: request.capability, missingProtocols: kinds },
          userMessage: '当前配置的模型服务协议暂不支持，请更换模型或联系管理员。',
          suggestions: ['在设置中改用 OpenAI 兼容协议的模型'],
        },
      );
    }

    const attempts: ModelInvokeResult['attempts'] = [];
    const startedAt = Date.now();
    let lastError: unknown = null;

    for (let index = 0; index < runnable.length; index += 1) {
      const entry = runnable[index];
      if (!entry) continue;
      const { model, provider, adapter } = entry;

      // 同一模型内重试
      for (let retry = 0; retry <= policy.maxRetries; retry += 1) {
        const attemptStart = Date.now();
        try {
          const apiKey = await this.resolveSecret(provider.providerId);
          if (apiKey === null && provider.kind !== 'custom') {
            throw new ProviderUnavailableError(
              `模型服务商「${provider.name}」尚未配置 API Key`,
              { context: { providerId: provider.providerId, modelId: model.modelId } },
            );
          }

          const raw = await this.invokeWithTimeout(adapter, provider, model, request, policy, apiKey);

          const latencyMs = Date.now() - attemptStart;
          attempts.push({ modelId: model.modelId, ok: true, durationMs: latencyMs });

          const result: ModelInvokeResult = {
            modelId: model.modelId,
            providerId: provider.providerId,
            fallbackUsed: index > 0,
            latencyMs: Date.now() - startedAt,
            attempts,
            ...(raw.text !== undefined ? { text: raw.text } : {}),
            ...(raw.data !== undefined ? { data: raw.data } : {}),
            ...(raw.files !== undefined ? { files: raw.files } : {}),
            ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
          };

          if (index > 0) {
            // 面向用户的降级说明（技术文档第 67 条）
            const first = chain[0];
            result.fallbackNote = `原模型${first ? `（${first.displayName}）` : ''}暂时不可用，已自动切换备用模型继续生成。`;
          }

          // 调用记录是即发即忘：模型调用已经成功，审计写入失败不应让
          // 用户的操作失败。因此显式忽略 Promise（记录器内部自行处理错误）。
          void this.recordCall?.({
            providerId: provider.providerId,
            modelId: model.modelId,
            capability: request.capability,
            context,
            status: 'succeeded',
            prompt: request.prompt,
            params: { ...model.defaultParams, ...request.params },
            ...(raw.data !== undefined || raw.text !== undefined
              ? { result: { text: raw.text, data: raw.data } as Record<string, unknown> }
              : {}),
            latencyMs,
            ...(raw.usage !== undefined
              ? { usage: raw.usage as unknown as Record<string, unknown> }
              : {}),
            attempts: attempts.length,
            attemptChain: attempts,
          });

          return result;
        } catch (err) {
          const durationMs = Date.now() - attemptStart;
          const svhError = toSvhError(err);
          lastError = svhError;
          attempts.push({
            modelId: model.modelId,
            ok: false,
            errorCode: svhError.code,
            durationMs,
          });

          this.logger?.warn(
            `模型 ${model.displayName} 第 ${retry + 1}/${policy.maxRetries + 1} 次调用失败：${svhError.code}`,
            { modelId: model.modelId, providerId: provider.providerId },
          );

          // 不可重试（如内容被安全策略拒绝），直接换下一个模型或结束
          if (!svhError.retryable) break;

          // 最后一次重试不再等待
          if (retry < policy.maxRetries) {
            const backoff = policy.backoffMs * 2 ** retry + Math.random() * policy.backoffMs;
            try {
              await sleep(backoff, undefined);
            } catch {
              break;
            }
          }
        }
      }

      // 该模型的重试已耗尽
      if (!policy.allowFallback) break;

      // 若错误与模型无关（如配置缺失），继续换模型也没意义
      if (lastError !== null && !isModelScopedFailure(lastError)) break;
    }

    // 全部候选失败
    const finalError = toSvhError(lastError);
    // 同上：失败记录也是即发即忘，不能覆盖真正的业务错误
    void this.recordCall?.({
      providerId: decision.chosen?.providerId ?? 'unknown',
      modelId: decision.chosen?.modelId ?? 'unknown',
      capability: request.capability,
      context,
      status: 'failed',
      prompt: request.prompt,
      params: request.params,
      error: finalError.message,
      latencyMs: Date.now() - startedAt,
      attempts: attempts.length,
      attemptChain: attempts,
    });

    throw new ProviderUnavailableError(
      `全部候选模型调用失败，最后错误：${finalError.message}`,
      {
        cause: lastError,
        context: {
          capability: request.capability,
          triedModels: attempts.map((a) => a.modelId).join(','),
        },
        // 已经把降级链路尝试完毕，再重试意义有限
        retryable: finalError.retryable,
      },
    );
  }

  /** 单次调用 + 超时 + 取消信号传导 */
  private async invokeWithTimeout(
    adapter: ProviderAdapter,
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: ModelInvokeRequest,
    policy: ResolvedPolicy,
    apiKey: string | null,
  ): Promise<Awaited<ReturnType<ProviderAdapter['invoke']>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

    try {
      const params = {
        modelKey: model.modelKey,
        capability: request.capability,
        prompt: request.prompt,
        params: { ...model.defaultParams, ...request.params },
        referenceImages: [...request.referenceImages],
        provider,
        apiKey,
        timeoutMs: policy.timeoutMs,
        signal: controller.signal,
        ...(request.negativePrompt !== undefined
          ? { negativePrompt: request.negativePrompt }
          : {}),
        ...(request.responseSchema !== undefined
          ? { responseSchema: request.responseSchema }
          : {}),
      };

      return await adapter.invoke(params);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ModelTimeoutError(
          `模型调用超时（${policy.timeoutMs}ms，模型 ${model.displayName}）`,
          { cause: err, context: { modelId: model.modelId, timeoutMs: policy.timeoutMs } },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 计算一次调用的成本估算（供 model_tasks.costEstimate 使用） */
export function estimateCost(model: ModelDescriptor, units: number): string | null {
  if (model.unitCost === null || model.unitCost === undefined) return null;
  const unit = Number.parseFloat(model.unitCost);
  if (!Number.isFinite(unit)) return null;
  // 用整数分表示，避免浮点误差累积
  return (Math.round(unit * units * 10000) / 10000).toFixed(4);
}

/** 供测试与诊断：导出默认策略 */
export const DEFAULT_ROUTING_POLICY = DEFAULT_POLICY;
