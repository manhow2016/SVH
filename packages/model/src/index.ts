/**
 * @svh/model —— Model Router
 *
 * 技术文档第 29 / 30 / 67 条的落点：**Agent 与 Skill 都不直接调用模型**。
 *
 * ```
 * Skill → Model Router → Provider → Model
 * ```
 *
 * 本包的设计边界（审计结论 ②：端口/适配器隔离）：
 * - **不依赖 Prisma、不依赖 HTTP 框架**
 * - 模型目录由调用方查询数据库后传入
 * - API Key 由调用方通过 `SecretResolver` 解密后传入（BYOK）
 * - 调用记录通过 `ModelCallRecorder` 回调交回调用方落库
 *
 * 因此 Model Router 可以脱离数据库做完整单测。
 *
 * Phase 2 交付：端口定义、选模与降级逻辑、Mock Provider。
 * Phase 3 交付：OpenAI / Anthropic / Gemini 兼容协议的真实适配器。
 */
export { ModelRouter, DEFAULT_ROUTING_POLICY, estimateCost } from './router.js';
export type {
  ModelCallContext,
  ModelCallRecorder,
  ModelDescriptor,
  ModelRouterOptions,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderInvokeParams,
  ProviderRawResult,
  RoutingDecision,
  SecretResolver,
} from './ports.js';
export {
  MockProviderAdapter,
  buildMockModelDescriptor,
  synthesizeFromSchema,
} from './mock.js';
export type { MockFailureRule, MockProviderOptions } from './mock.js';

// 真实 Provider 适配器（Phase 3）
export {
  AnthropicAdapter,
  createAdapterFor,
  createDefaultAdapters,
  GeminiAdapter,
  hasBuiltinAdapter,
  OpenAICompatibleAdapter,
  SUPPORTED_PROVIDER_KINDS,
} from './providers/index.js';
export {
  extractErrorMessage,
  joinUrl,
  mapHttpErrorToSvhError,
  normalizeForAnthropicTool,
  normalizeForGemini,
  normalizeForStrict,
  parseAspectRatio,
  parseJsonLoose,
  requestJson,
  sanitizeCredentials,
} from './providers/index.js';
