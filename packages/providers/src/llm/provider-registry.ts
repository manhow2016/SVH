import type { LLMProvider } from "./provider";

/**
 * Provider Registry（文档 §12）。
 *
 * Agent Runtime 不直接实例化 Provider：
 * Agent Runtime → Provider Registry → Provider
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): LLMProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${id}`);
    }
    return provider;
  }

  list(): LLMProvider[] {
    return [...this.providers.values()];
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }
}
