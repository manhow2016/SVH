/**
 * Model Router 测试
 *
 * 模型层是「Agent 与具体模型解耦」的关键抽象，因此它的三类决策必须被锁住：
 *   1. **选模**：按策略（质量 / 成本 / 速度 / 手动）与 Provider 健康度排序
 *   2. **重试**：同一模型内的指数退避重试
 *   3. **降级**：模型耗尽重试后切换下一个候选，并记录「已自动切换」的说明
 *
 * 用假适配器而非 Mock Provider，是为了能精确控制失败次数与顺序 ——
 * 这样重试与降级的边界才测得准。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  isProviderFailureCode,
  ModelNotConfiguredError,
  ProviderUnavailableError,
  type ModelCapability,
} from '@svh/domain';

import { ModelRouter } from '../src/router.js';
import type {
  ModelDescriptor,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderInvokeParams,
  ProviderRawResult,
} from '../src/ports.js';

/** 构造一个模型描述 */
function model(input: {
  modelId: string;
  providerId?: string;
  capabilities?: ModelCapability[];
  priority?: number;
  unitCost?: string;
  health?: ModelDescriptor['providerHealth'];
  enabled?: boolean;
}): ModelDescriptor {
  return {
    modelId: input.modelId,
    providerId: input.providerId ?? 'p1',
    modelKey: input.modelId,
    displayName: `模型 ${input.modelId}`,
    capabilities: input.capabilities ?? ['image'],
    priority: input.priority ?? 100,
    supportsStreaming: false,
    supportsAsync: false,
    defaultParams: {},
    enabled: input.enabled ?? true,
    providerHealth: input.health ?? 'healthy',
    providerName: `Provider ${input.providerId ?? 'p1'}`,
    // unitCost 必须透传：漏掉它会让 cost 策略退化为按 id 字典序排序，
    // 测试却仍然"通过"（因为断言写成了错误的顺序）。
    ...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
  };
}

/** 构造 Provider 描述 */
function provider(input: { providerId?: string; enabled?: boolean } = {}): ProviderDescriptor {
  return {
    providerId: input.providerId ?? 'p1',
    name: `Provider ${input.providerId ?? 'p1'}`,
    kind: 'openai_compatible',
    baseUrl: 'https://example.test/v1',
    concurrency: 4,
    enabled: input.enabled ?? true,
  };
}

/** 可控的假适配器：按脚本决定第几次调用失败 */
function fakeAdapter(options: {
  /** 每个 modelKey 前 N 次调用失败 */
  failFirst?: Record<string, number>;
  /** 始终失败的 modelKey */
  alwaysFail?: string[];
  /** 返回的文本 */
  text?: string;
  /** 每次调用记录 */
  calls?: ProviderInvokeParams[];
}): ProviderAdapter {
  const counters = new Map<string, number>();

  return {
    kind: 'openai_compatible',
    async invoke(params): Promise<ProviderRawResult> {
      options.calls?.push(params);
      const next = (counters.get(params.modelKey) ?? 0) + 1;
      counters.set(params.modelKey, next);

      if (options.alwaysFail?.includes(params.modelKey) === true) {
        throw new ProviderUnavailableError(`模型 ${params.modelKey} 不可用`);
      }
      const budget = options.failFirst?.[params.modelKey];
      if (budget !== undefined && next <= budget) {
        throw new ProviderUnavailableError(`模型 ${params.modelKey} 第 ${next} 次调用失败`);
      }
      return { text: options.text ?? `来自 ${params.modelKey} 的回复` };
    },
  };
}

const silentLogger = { warn: () => undefined, info: () => undefined };

describe('选模策略', () => {
  it('quality 策略按 priority 降序选模', () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [
        model({ modelId: 'low', priority: 10 }),
        model({ modelId: 'high', priority: 500 }),
        model({ modelId: 'mid', priority: 200 }),
      ],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const { candidates } = router.selectCandidates('image', {
      strategy: 'quality',
      maxRetries: 0,
      allowFallback: true,
      maxFallbacks: 3,
      timeoutMs: 1000,
      backoffMs: 0,
      allowSharedProviders: true,
    });

    expect(candidates.map((m) => m.modelId)).toEqual(['high', 'mid', 'low']);
  });

  it('cost 策略按单价升序选模', () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [
        model({ modelId: 'expensive', unitCost: '0.50' }),
        model({ modelId: 'cheap', unitCost: '0.01' }),
        model({ modelId: 'medium', unitCost: '0.10' }),
      ],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const { candidates } = router.selectCandidates('image', {
      strategy: 'cost',
      maxRetries: 0,
      allowFallback: true,
      maxFallbacks: 3,
      timeoutMs: 1000,
      backoffMs: 0,
      allowSharedProviders: true,
    });

    expect(candidates.map((m) => m.modelId)).toEqual(['cheap', 'medium', 'expensive']);
  });


  it('cost 策略下缺少单价的模型排到最后（视为成本未知）', () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [
        model({ modelId: 'unknown-cost', priority: 999 }),
        model({ modelId: 'priced', unitCost: '0.20' }),
      ],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const { candidates } = router.selectCandidates('image', {
      strategy: 'cost',
      maxRetries: 0,
      allowFallback: true,
      maxFallbacks: 3,
      timeoutMs: 1000,
      backoffMs: 0,
      allowSharedProviders: true,
    });

    // 即使 unknown-cost 的 priority 更高，单价已知的模型仍优先
    expect(candidates.map((m) => m.modelId)).toEqual(['priced', 'unknown-cost']);
  });

  it('排除不支持所需能力的模型', () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [
        model({ modelId: 'image-only', capabilities: ['image'] }),
        model({ modelId: 'video-only', capabilities: ['video'] }),
      ],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const { candidates } = router.selectCandidates('video', {
      strategy: 'quality',
      maxRetries: 0,
      allowFallback: true,
      maxFallbacks: 3,
      timeoutMs: 1000,
      backoffMs: 0,
      allowSharedProviders: true,
    });

    expect(candidates.map((m) => m.modelId)).toEqual(['video-only']);
  });

  it('排除被禁用的模型与 Provider', () => {
    const router = new ModelRouter({
      providers: [provider(), provider({ providerId: 'p2', enabled: false })],
      models: [
        model({ modelId: 'enabled' }),
        model({ modelId: 'disabled-model', enabled: false }),
        model({ modelId: 'disabled-provider', providerId: 'p2' }),
      ],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const { candidates } = router.selectCandidates('image', {
      strategy: 'quality',
      maxRetries: 0,
      allowFallback: true,
      maxFallbacks: 3,
      timeoutMs: 1000,
      backoffMs: 0,
      allowSharedProviders: true,
    });

    expect(candidates.map((m) => m.modelId)).toEqual(['enabled']);
  });

  it('health=down 的 Provider 模型被排除，degraded 的排在健康之后', () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [
        model({ modelId: 'down', health: 'down', priority: 900 }),
        model({ modelId: 'degraded', health: 'degraded', priority: 800 }),
        model({ modelId: 'healthy', health: 'healthy', priority: 100 }),
      ],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const { candidates } = router.selectCandidates('image', {
      strategy: 'quality',
      maxRetries: 0,
      allowFallback: true,
      maxFallbacks: 3,
      timeoutMs: 1000,
      backoffMs: 0,
      allowSharedProviders: true,
    });

    // down 被排除；degraded 虽有更高 priority 但排在 healthy 之后
    expect(candidates.map((m) => m.modelId)).toEqual(['healthy', 'degraded']);
  });

  it('manual 策略只使用指定模型', () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'a' }), model({ modelId: 'b' })],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const { candidates } = router.selectCandidates('image', {
      strategy: 'manual',
      modelId: 'b',
      maxRetries: 0,
      allowFallback: true,
      maxFallbacks: 3,
      timeoutMs: 1000,
      backoffMs: 0,
      allowSharedProviders: true,
    });

    expect(candidates.map((m) => m.modelId)).toEqual(['b']);
  });

  it('manual 指定的模型不支持该能力时报错', () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'image-only', capabilities: ['image'] })],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    expect(() =>
      router.selectCandidates('video', {
        strategy: 'manual',
        modelId: 'image-only',
        maxRetries: 0,
        allowFallback: true,
        maxFallbacks: 3,
        timeoutMs: 1000,
        backoffMs: 0,
        allowSharedProviders: true,
      }),
    ).toThrow(ModelNotConfiguredError);
  });
});

describe('重试（同一模型内）', () => {
  it('瞬时失败后重试成功，且记录两次尝试', async () => {
    const calls: ProviderInvokeParams[] = [];
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'flaky' })],
      adapters: [fakeAdapter({ failFirst: { flaky: 1 }, calls })],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const result = await router.invoke({
      capability: 'image',
      prompt: '测试',
      params: {},
      referenceImages: [],
      routing: { maxRetries: 2, backoffMs: 0 },
    });

    expect(result.text).toContain('flaky');
    expect(result.fallbackUsed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[1]?.ok).toBe(true);
  });
});

describe('降级（切换模型）', () => {
  it('主模型失败后自动切换备用模型，并给出面向用户的说明', async () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [
        model({ modelId: 'primary', priority: 900 }),
        model({ modelId: 'backup', priority: 100 }),
      ],
      adapters: [fakeAdapter({ alwaysFail: ['primary'] })],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    const result = await router.invoke({
      capability: 'image',
      prompt: '测试',
      params: {},
      referenceImages: [],
      routing: { maxRetries: 0, backoffMs: 0 },
    });

    expect(result.modelId).toBe('backup');
    expect(result.fallbackUsed).toBe(true);
    // 技术文档第 67 条要求告知用户「已自动切换备用模型」
    expect(result.fallbackNote).toContain('已自动切换备用模型');
    // 降级链路被记录，便于问题定位
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
    expect(result.attempts[0]?.ok).toBe(false);
  });

  it('allowFallback=false 时不做降级', async () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'primary', priority: 900 }), model({ modelId: 'backup', priority: 100 })],
      adapters: [fakeAdapter({ alwaysFail: ['primary'] })],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    await expect(
      router.invoke({
        capability: 'image',
        prompt: '测试',
        params: {},
        referenceImages: [],
        routing: { maxRetries: 0, backoffMs: 0, allowFallback: false },
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('maxFallbacks 限制尝试的模型数量', async () => {
    const calls: ProviderInvokeParams[] = [];
    const router = new ModelRouter({
      providers: [provider()],
      models: [
        model({ modelId: 'm1', priority: 900 }),
        model({ modelId: 'm2', priority: 800 }),
        model({ modelId: 'm3', priority: 700 }),
        model({ modelId: 'm4', priority: 600 }),
      ],
      adapters: [fakeAdapter({ alwaysFail: ['m1', 'm2', 'm3', 'm4'], calls })],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    await expect(
      router.invoke({
        capability: 'image',
        prompt: '测试',
        params: {},
        referenceImages: [],
        routing: { maxRetries: 0, backoffMs: 0, maxFallbacks: 1 },
      }),
    ).rejects.toThrow(ProviderUnavailableError);

    // maxFallbacks=1 表示最多尝试 2 个模型
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.modelKey)).toEqual(['m1', 'm2']);
  });

  it('全部候选失败时抛出可重试的 ProviderUnavailableError', async () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'only' })],
      adapters: [fakeAdapter({ alwaysFail: ['only'] })],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    try {
      await router.invoke({
        capability: 'image',
        prompt: '测试',
        params: {},
        referenceImages: [],
        routing: { maxRetries: 0, backoffMs: 0 },
      });
      throw new Error('应当抛出错误');
    } catch (err) {
      const error = err as ProviderUnavailableError;
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      // 该错误属于「模型服务商类」，领域层据此决定是否重试任务
      expect(isProviderFailureCode(error.code)).toBe(true);
      // 尝试过的模型被记录在上下文里，便于排查
      expect(error.context.triedModels).toContain('only');
    }
  });
});

describe('凭据与配置', () => {
  it('没有可用模型时抛出 MODEL_NOT_CONFIGURED', async () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    await expect(
      router.invoke({ capability: 'image', prompt: 'x', params: {}, referenceImages: [] }),
    ).rejects.toThrow(ModelNotConfiguredError);
  });

  it('Provider 未配置 API Key 时给出明确错误', async () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'm1' })],
      adapters: [fakeAdapter({})],
      // 密钥解析返回 null 表示未配置
      resolveSecret: async () => null,
      logger: silentLogger,
    });

    await expect(
      router.invoke({
        capability: 'image',
        prompt: 'x',
        params: {},
        referenceImages: [],
        routing: { maxRetries: 0 },
      }),
    ).rejects.toThrow(/API Key/);
  });

  it('没有对应协议的适配器时跳过该模型', async () => {
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'm1' })],
      // 不注册任何适配器
      adapters: [],
      resolveSecret: async () => 'key',
      logger: silentLogger,
    });

    await expect(
      router.invoke({ capability: 'image', prompt: 'x', params: {}, referenceImages: [] }),
    ).rejects.toThrow(ModelNotConfiguredError);
  });
});

describe('调用记录（成本归因）', () => {
  it('成功调用会带上业务上下文交给记录器', async () => {
    const recordCall = vi.fn().mockResolvedValue(undefined);
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'm1' })],
      adapters: [fakeAdapter({})],
      resolveSecret: async () => 'key',
      recordCall,
      logger: silentLogger,
    });

    await router.invoke(
      { capability: 'image', prompt: '记录测试', params: {}, referenceImages: [] },
      { taskId: 'task-1', skillId: 'image.generate', projectId: 'proj-1' },
    );

    expect(recordCall).toHaveBeenCalledTimes(1);
    const record = recordCall.mock.calls[0]?.[0] as {
      status: string;
      capability: string;
      context?: { taskId?: string; skillId?: string };
    };
    expect(record.status).toBe('succeeded');
    expect(record.capability).toBe('image');
    // taskId 是 model_tasks 做成本归因的关联键
    expect(record.context?.taskId).toBe('task-1');
    expect(record.context?.skillId).toBe('image.generate');
  });

  it('失败调用也会被记录，便于统计失败率', async () => {
    const recordCall = vi.fn().mockResolvedValue(undefined);
    const router = new ModelRouter({
      providers: [provider()],
      models: [model({ modelId: 'm1' })],
      adapters: [fakeAdapter({ alwaysFail: ['m1'] })],
      resolveSecret: async () => 'key',
      recordCall,
      logger: silentLogger,
    });

    await expect(
      router.invoke(
        { capability: 'image', prompt: 'x', params: {}, referenceImages: [], routing: { maxRetries: 0 } },
        { taskId: 'task-2' },
      ),
    ).rejects.toThrow(ProviderUnavailableError);

    expect(recordCall).toHaveBeenCalledTimes(1);
    expect((recordCall.mock.calls[0]?.[0] as { status: string }).status).toBe('failed');
  });
});
