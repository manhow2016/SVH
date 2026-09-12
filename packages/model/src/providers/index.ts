/**
 * Provider 适配器工厂
 *
 * 按 Provider 的协议类型（kind）选择对应适配器。
 *
 * 审计结论 ⑨：**不要每次调用都重建适配器**。
 * 适配器是无状态的（所有调用参数都通过 `ProviderInvokeParams` 传入），
 * 因此可以安全地在进程内复用同一批实例，避免高频调用下反复分配对象。
 */
import type { ProviderAdapter, ProviderDescriptor } from '../ports.js';

import { MockProviderAdapter } from '../mock.js';

import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

/**
 * 创建全部内置适配器。
 *
 * 返回的数组可直接传给 `ModelRouter` 的 `adapters` 参数。
 * Router 内部按 `kind` 建索引，因此顺序无关。
 */
export function createDefaultAdapters(): ProviderAdapter[] {
  return [
    new OpenAICompatibleAdapter(),
    new AnthropicAdapter(),
    new GeminiAdapter(),
    // Mock 也一并注册：它的协议独立，不会与真实适配器冲突，
    // 因此可以作为「未配置真实模型时的兜底」长期存在
    new MockProviderAdapter(),
  ];
}

/**
 * 按协议类型取适配器。
 *
 * `custom` 协议没有内置实现 —— 它预留给用户自行实现适配器并注入的场景。
 * 返回 undefined 时 Model Router 会跳过使用该协议的模型并记录警告
 * （而不是静默失败或抛出一个难以理解的错误）。
 */
export function createAdapterFor(kind: ProviderDescriptor['kind']): ProviderAdapter | undefined {
  switch (kind) {
    case 'openai_compatible':
      return new OpenAICompatibleAdapter();
    case 'anthropic_compatible':
      return new AnthropicAdapter();
    case 'gemini_compatible':
      return new GeminiAdapter();
    case 'mock':
      return new MockProviderAdapter();
    case 'custom':
    default:
      return undefined;
  }
}

/** 判断某个协议是否有内置适配器 */
export function hasBuiltinAdapter(kind: ProviderDescriptor['kind']): boolean {
  return kind !== 'custom';
}

/** 真实（非 Mock）协议清单 */
export function isRealProviderKind(kind: ProviderDescriptor['kind']): boolean {
  return kind !== 'mock' && kind !== 'custom';
}

/** 内置支持的协议清单（供 API 与前端展示可选项） */
export const SUPPORTED_PROVIDER_KINDS = [
  'openai_compatible',
  'anthropic_compatible',
  'gemini_compatible',
] as const;

export { AnthropicAdapter, GeminiAdapter, OpenAICompatibleAdapter };
export {
  AnthropicAdapter as Anthropic,
  GeminiAdapter as Gemini,
  OpenAICompatibleAdapter as OpenAICompatible,
};

// 协议辅助函数：供测试与诊断直接引用
export {
  normalizeForStrict,
  parseAspectRatio,
  parseJsonLoose,
} from './openai-compatible.js';
export { normalizeForAnthropicTool } from './anthropic.js';
export { fillPathTemplate, normalizeForGemini } from './gemini.js';
export {
  extractErrorMessage,
  joinUrl,
  mapHttpErrorToSvhError,
  requestJson,
  sanitizeCredentials,
} from './http.js';
