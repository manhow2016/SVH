import type { LLMProvider } from "./provider";
import { Registry } from "../registry";

/**
 * LLM Provider Registry（文档 §12，兼容既有 API）。
 *
 * 语义：keyed by provider.id，后注册覆盖先注册；
 * 运行时按当前用户配置现场注册实例（见 run-service）。
 */
export class ProviderRegistry extends Registry<LLMProvider> {}
