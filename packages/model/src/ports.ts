/**
 * Model Router 的端口（Port）定义
 *
 * ── 审计结论 ②：端口/适配器隔离所有外部依赖 ──
 * 参考项目的 `packages/ai` 不依赖 Prisma、不依赖 HTTP，BYOK（用户自带密钥）
 * 靠注入 `SecretResolver(providerId, userId)` 实现。SVH 继承这一点：
 *
 *   本包**不 import Prisma、不 import Fastify**；
 *   - 模型目录（有哪些 Provider / Model）由调用方查询数据库后传入
 *   - API Key 由调用方通过 SecretResolver 解密后传入
 *   - 调用记录通过 ModelCallRecorder 回调交回调用方落库
 *
 * 这样做的直接收益：Model Router 可以脱离数据库做完整单测，
 * 并且换掉持久化方案时不需要改动模型层。
 */
import type {
  ModelCapability,
  ModelInvokeResult,
  ModelRoutingPolicy,
  ProviderHealth,
} from '@svh/domain';

/** 单个模型的运行时描述（由调用方从数据库映射而来） */
export interface ModelDescriptor {
  modelId: string;
  providerId: string;
  /** Provider 侧的模型标识，如 doubao-seedream-3-0-t2i */
  modelKey: string;
  displayName: string;
  capabilities: readonly ModelCapability[];
  /** 数值越大越优先（quality 策略使用） */
  priority: number;
  supportsStreaming: boolean;
  supportsAsync: boolean;
  contextWindow?: number | null;
  maxDurationSeconds?: number | null;
  supportedSizes?: readonly string[];
  /** 单次调用单价（用户视角，字符串避免浮点误差） */
  unitCost?: string | null;
  defaultParams: Record<string, unknown>;
  enabled: boolean;
  /** Provider 健康状态，degraded / down 的候选会被降权或跳过 */
  providerHealth: ProviderHealth;
  providerName: string;
}

/** Provider 连接信息（密钥由 SecretResolver 单独提供） */
export interface ProviderDescriptor {
  providerId: string;
  name: string;
  kind: 'openai_compatible' | 'anthropic_compatible' | 'gemini_compatible' | 'mock' | 'custom';
  baseUrl: string;
  /** 非敏感的自定义请求头 */
  headers?: Record<string, string>;
  /**
   * 协议侧的适配参数（**不含密钥**）。
   *
   * 「OpenAI 兼容」只对文本接口真正统一，图片 / 视频 / 音频的路径与报文
   * 各家差异很大。因此把端点覆盖、字段名映射、结构化输出模式等放在这里，
   * 由适配器读取，而不是把厂商差异硬编码进适配器。
   */
  config?: Record<string, unknown>;
  concurrency: number;
  rateLimitPerMinute?: number | null;
  enabled: boolean;
}

/**
 * 密钥解析器。
 *
 * 它是 BYOK 的关键：模型层只知道「要一个密钥」，不知道密钥存在哪、如何解密。
 */
export type SecretResolver = (providerId: string) => Promise<string | null>;

/** 模型调用请求（传给 Provider 适配器） */
export interface ProviderInvokeParams {
  modelKey: string;
  capability: ModelCapability;
  prompt: string;
  negativePrompt?: string;
  /** 结构化输出约束（文本类能力使用） */
  responseSchema?: Record<string, unknown>;
  params: Record<string, unknown>;
  referenceImages: string[];
  /** Provider 连接信息 */
  provider: ProviderDescriptor;
  /** 已解密的 API Key；为 null 表示未配置 */
  apiKey: string | null;
  /** 单次调用超时 */
  timeoutMs: number;
  /** 取消信号：Worker 被取消时必须传导到 Provider 以停止计费 */
  signal?: AbortSignal;
}

/** Provider 适配器返回的原始结果 */
export interface ProviderRawResult {
  text?: string;
  /** 已解析的结构化输出 */
  data?: unknown;
  files?: ModelInvokeResult['files'];
  usage?: ModelInvokeResult['usage'];
  /** Provider 侧任务 id（异步任务轮询用） */
  externalId?: string;
}

/**
 * Provider 适配器接口。
 *
 * 一个适配器对应一种「协议」（OpenAI 兼容 / Anthropic / Gemini），
 * 通过 `modelKey` 区分同协议下的不同模型。
 */
export interface ProviderAdapter {
  /** 适配器标识，用于日志与错误信息 */
  readonly kind: ProviderDescriptor['kind'];
  /**
   * 执行一次模型调用。
   *
   * 约定：适配器**只负责协议转换与 HTTP 调用**，
   * 不负责重试、降级、成本计算 —— 这些由 Model Router 统一处理。
   * 失败时必须抛出 `SvhError`（或会被包装成 SvhError 的异常）。
   */
  invoke(params: ProviderInvokeParams): Promise<ProviderRawResult>;
  /** 健康检查（可选）。未实现时 Router 使用调用结果推断健康状态。 */
  checkHealth?(provider: ProviderDescriptor, apiKey: string | null): Promise<ProviderHealth>;
}

/** 路由决策记录，便于排查「为什么选了这个模型」 */
export interface RoutingDecision {
  capability: ModelCapability;
  strategy: ModelRoutingPolicy['strategy'];
  /** 候选模型（已按策略排序） */
  candidates: Array<{ modelId: string; providerId: string; reason: string }>;
  /** 实际选中的 */
  chosen?: { modelId: string; providerId: string };
}

/**
 * 模型调用的业务上下文。
 *
 * Model Router 本身不知道「这次调用属于哪个任务 / 技能」——那是业务概念。
 * 但 `model_tasks` 表需要 taskId 才能做成本归因，因此由调用方
 * 通过 `invoke(request, context)` 显式传入，Router 只负责透传给记录器。
 */
export interface ModelCallContext {
  taskId?: string | null;
  skillId?: string | null;
  contentId?: string | null;
  projectId?: string | null;
}

/** 模型调用记录回调（由调用方落库到 model_tasks） */
export type ModelCallRecorder = (record: {
  providerId: string;
  modelId: string;
  capability: ModelCapability;
  /** 业务上下文，供成本归因与链路追溯 */
  context?: ModelCallContext;
  status: 'succeeded' | 'failed';
  prompt: string;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  latencyMs: number;
  usage?: Record<string, unknown>;
  attempts: number;
  attemptChain: unknown[];
}) => Promise<void>;

/** Model Router 的构造参数 */
export interface ModelRouterOptions {
  /** 已注册的 Provider 描述 */
  providers: ProviderDescriptor[];
  /** 可用模型目录 */
  models: ModelDescriptor[];
  /** 协议适配器（按 kind 匹配） */
  adapters: ProviderAdapter[];
  /** 密钥解析器（BYOK） */
  resolveSecret: SecretResolver;
  /** 调用记录回调，可选 */
  recordCall?: ModelCallRecorder;
  /** 日志器，可选（不引入日志库，由调用方注入） */
  logger?: {
    warn(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
  };
}
