/**
 * 通用 Provider 注册表（V0.2：原 ProviderRegistry 泛型化为 Registry<T>）。
 *
 * - LLM 既有用法不变：`ProviderRegistry`（即 Registry<LLMProvider>）保留导出
 * - Image / Video 等能力可实例化各自 Registry（如 Registry<ImageProvider>）
 */
export class Registry<T extends { id: string }> {
  private readonly entries = new Map<string, T>();

  register(provider: T): void {
    this.entries.set(provider.id, provider);
  }

  get(id: string): T {
    const provider = this.entries.get(id);
    if (!provider) {
      throw new Error(`Unknown provider: ${id}`);
    }
    return provider;
  }

  list(): T[] {
    return [...this.entries.values()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }
}
