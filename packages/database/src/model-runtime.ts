/**
 * 模型目录装配（数据库 → Model Router 的输入）
 *
 * 职责：把 `model_providers` / `models` 两张表翻译成 `@svh/model` 需要的
 * `ProviderDescriptor[]` 与 `ModelDescriptor[]`，并提供密钥解析器。
 *
 * ── 为什么需要 Mock 回落 ──
 * 开发与自动化测试环境没有真实 API Key。此时若目录为空，
 * Model Router 会抛 `MODEL_NOT_CONFIGURED`，导致整条链路无法验证。
 *
 * 回落条件只有一个：**数据库里没有任何可用的真实模型**。
 * 刻意不引入「Mock / 真实」的环境开关 —— 那会产生
 * 「配置了真实 Provider 却被开关静默忽略」的危险组合。
 */
import type { ModelCapability, ProviderHealth } from '@svh/domain';
import {
  buildMockModelDescriptor,
  createDefaultAdapters,
  MockProviderAdapter,
  ModelRouter,
  type ModelDescriptor,
  type ProviderAdapter,
  type ProviderDescriptor,
} from '@svh/model';

import { prisma } from './client.js';
import { decryptSecret } from './crypto.js';
import { recordModelTask } from './tasks.js';

/** Mock Provider 的固定标识，便于在日志与 UI 中辨识 */
export const MOCK_PROVIDER_ID = 'provider_mock';
const MOCK_PROVIDER_NAME = 'Mock Provider（开发用）';

/** 构造 Mock Provider 描述 */
function buildMockProvider(): ProviderDescriptor {
  return {
    providerId: MOCK_PROVIDER_ID,
    name: MOCK_PROVIDER_NAME,
    kind: 'mock',
    baseUrl: 'mock://local',
    concurrency: 8,
    enabled: true,
  };
}

/**
 * 构造 Mock 模型目录。
 *
 * 刻意拆成「文本 / 图片 / 视频」三个模型而不是一个大模型：
 * 这样能验证 Model Router 的**按能力选模**确实生效，
 * 而不是永远命中同一个默认模型。
 */
function buildMockModels(): ModelDescriptor[] {
  const groups: Array<{ key: string; name: string; capabilities: ModelCapability[]; priority: number }> = [
    { key: 'mock-text-v1', name: 'Mock 文本模型', capabilities: ['text', 'script', 'subtitle'], priority: 200 },
    { key: 'mock-image-v1', name: 'Mock 图像模型', capabilities: ['image', 'image_edit'], priority: 200 },
    {
      key: 'mock-video-v1',
      name: 'Mock 视频模型',
      capabilities: ['video', 'video_extend', 'digital_human'],
      priority: 200,
    },
    { key: 'mock-audio-v1', name: 'Mock 音频模型', capabilities: ['audio', 'voice', 'music'], priority: 200 },
  ];

  return groups.map((group) =>
    buildMockModelDescriptor({
      // 模型 id 会作为 `generation.modelId` 写进资产 metadata，而该字段由
      // @svh/domain 的 idSchema 校验（只允许 [a-z0-9]）。
      // 因此必须剔除 modelKey 中的连字符与下划线 —— 否则生成类技能会在
      // 「资产校验」这一步失败，且错误指向 metadata 而非模型配置，极难定位。
      // （text.generate 不写该字段，因此不会暴露这个问题。）
      modelId: `mock${group.key.replace(/[^a-z0-9]/gi, '').toLowerCase()}`,
      providerId: MOCK_PROVIDER_ID,
      modelKey: group.key,
      displayName: group.name,
      capabilities: group.capabilities,
      priority: group.priority,
    }),
  );
}

/** 装配结果 */
export interface ModelRuntime {
  router: ModelRouter;
  /** 本次装配是否使用了 Mock（供启动日志与就绪探针展示） */
  usingMock: boolean;
  providers: ProviderDescriptor[];
  models: ModelDescriptor[];
  /** 已注册的协议适配器列表 */
  adapterKinds: string[];
}

/** 装配参数 */
export interface BuildModelRuntimeOptions {
  /** 来自配置的 SECRET_ENCRYPTION_KEY */
  encryptionKey: string;
  /**
   * 强制只使用 Mock（自动化测试用）。
   *
   * 生产代码不应设置它 —— 正常逻辑是「有真实模型就用真实的」，
   * 由数据库内容自动判定，不需要外部开关。
   */
  forceMock?: boolean;
  logger?: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
  };
  /** 自定义 Mock 故障注入，供测试验证重试与降级 */
  mockAdapter?: MockProviderAdapter;
}

/**
 * 由数据库装配 Model Router。
 *
 * 模型目录在每次装配时读取一次并缓存于 Router 实例中；
 * 若用户在运行期修改了 Provider 配置，需要重建 Router
 * （Phase 3 会加入配置变更事件来触发重建）。
 */
export async function buildModelRuntime(
  options: BuildModelRuntimeOptions,
): Promise<ModelRuntime> {
  const forceMock = options.forceMock ?? false;

  const providers: ProviderDescriptor[] = [];
  const models: ModelDescriptor[] = [];
  const adapters: ProviderAdapter[] = [];

  if (!forceMock) {
    // 读取真实 Provider 配置
    const rows = await prisma.modelProvider.findMany({
      where: { enabled: true },
      include: { models: { where: { enabled: true } } },
    });

    for (const row of rows) {
      providers.push({
        providerId: row.id,
        name: row.name,
        kind: row.kind,
        baseUrl: row.baseUrl,
        headers: (row.headers ?? {}) as Record<string, string>,
        // 协议侧配置（端点覆盖、字段映射等），不含密钥
        config: (row.config ?? {}) as Record<string, unknown>,
        concurrency: row.concurrency,
        rateLimitPerMinute: row.rateLimitPerMinute,
        enabled: row.enabled,
      });

      for (const model of row.models) {
        models.push({
          modelId: model.id,
          providerId: row.id,
          modelKey: model.modelKey,
          displayName: model.displayName,
          capabilities: model.capabilities as ModelCapability[],
          priority: model.priority,
          supportsStreaming: model.supportsStreaming,
          supportsAsync: model.supportsAsync,
          contextWindow: model.contextWindow,
          maxDurationSeconds: model.maxDurationSeconds,
          supportedSizes: model.supportedSizes,
          unitCost: model.unitCost,
          defaultParams: (model.defaultParams ?? {}) as Record<string, unknown>,
          enabled: model.enabled,
          providerHealth: row.health as ProviderHealth,
          providerName: row.name,
        });
      }
    }
  }

  // 没有任何真实模型时回落 Mock，保证链路仍可运行。
  // 注意：这里**不**因为某个外部开关而覆盖真实配置 ——
  // 有真实模型就必须用真实的。
  const fallbackToMock = forceMock || models.length === 0;

  // 真实 Provider 的适配器（OpenAI 兼容 / Anthropic / Gemini）。
  // 这三个协议与 Mock 的 kind 互不重叠，因此可以同时注册：
  // 有真实模型时用真实的，没有时用 Mock 兜底。
  adapters.push(...createDefaultAdapters());

  let usingMock = false;
  if (fallbackToMock) {
    providers.push(buildMockProvider());
    models.push(...buildMockModels());
    // 允许注入自定义 Mock（测试用故障注入）
    if (options.mockAdapter !== undefined) {
      const index = adapters.findIndex((a) => a.kind === 'mock');
      if (index >= 0) adapters.splice(index, 1, options.mockAdapter);
    }
    usingMock = true;

    if (!forceMock) {
      options.logger?.warn(
        '数据库中没有可用的模型配置，已自动回落 Mock Provider（输出为占位数据）。' +
          '请在设置中配置模型 API 以使用真实模型。',
      );
    }
  }

  const router = new ModelRouter({
    providers,
    models,
    adapters,
    resolveSecret: async (providerId: string) => {
      if (providerId === MOCK_PROVIDER_ID) return 'mock-key';
      return resolveProviderSecret(providerId, options.encryptionKey);
    },
    // 暴露 Provider 描述查询，供记录回调更新健康状态
    recordCall: async (record) => {
      try {
        // 真实 Provider 的调用结果回写健康状态：
        // 失败累计到阈值后 Model Router 会自动降级（技术文档第 67 条）。
        // Mock 不参与 —— 它的「失败」是测试注入的，不代表真实服务的健康度。
        if (record.providerId !== MOCK_PROVIDER_ID) {
          const { recordProviderFailure, recordProviderSuccess } = await import(
            './provider-health.js'
          );
          if (record.status === 'succeeded') {
            await recordProviderSuccess(record.providerId);
          } else {
            await recordProviderFailure(record.providerId);
          }
        }

        await recordModelTask({
          providerId: record.providerId.startsWith('model_') ? MOCK_PROVIDER_ID : record.providerId,
          modelId: await resolveModelRowId(record.modelId),
          capability: record.capability,
          // 业务上下文来自调用方透传，是成本归因与链路追溯的关联键
          taskId: record.context?.taskId ?? null,
          skillId: record.context?.skillId ?? null,
          prompt: record.prompt,
          params: record.params,
          status: record.status,
          ...(record.result !== undefined ? { result: record.result } : {}),
          ...(record.error !== undefined ? { error: record.error } : {}),
          latencyMs: record.latencyMs,
          ...(record.usage !== undefined ? { usage: record.usage } : {}),
          attempts: record.attempts,
          attemptChain: record.attemptChain,
        });
      } catch (err) {
        // 记录失败不应影响主流程：调用已经成功，只是审计信息缺失
        options.logger?.warn('模型调用记录写入失败', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  return {
    router,
    usingMock,
    providers,
    models,
    adapterKinds: router.listAdapterKinds(),
  };
}

/** 解析 Provider 的 API Key（解密） */
async function resolveProviderSecret(
  providerId: string,
  encryptionKey: string,
): Promise<string | null> {
  const row = await prisma.modelProvider.findUnique({
    where: { id: providerId },
    select: { apiKeyEncrypted: true },
  });
  if (!row || row.apiKeyEncrypted.length === 0) return null;

  try {
    return decryptSecret(row.apiKeyEncrypted, encryptionKey);
  } catch {
    // 解密失败通常意味着 SECRET_ENCRYPTION_KEY 被更换过。
    // 此时返回 null，让 Router 报出「未配置 API Key」而不是抛出难懂的加密错误。
    return null;
  }
}

/**
 * Mock 模型在数据库中没有对应行，但 `model_tasks.modelId` 是外键。
 * 这里把 Mock 模型映射到一个占位行上（首次调用时惰性创建）。
 */
let mockModelRowCache: Map<string, string> | null = null;

async function resolveModelRowId(modelId: string): Promise<string> {
  if (!modelId.startsWith('mock')) return modelId;

  if (mockModelRowCache === null) mockModelRowCache = new Map();
  const cached = mockModelRowCache.get(modelId);
  if (cached !== undefined) return cached;

  // 确保 Mock Provider 行存在
  const provider = await prisma.modelProvider.upsert({
    where: { id: MOCK_PROVIDER_ID },
    create: {
      id: MOCK_PROVIDER_ID,
      name: MOCK_PROVIDER_NAME,
      kind: 'custom',
      baseUrl: 'mock://local',
      apiKeyEncrypted: '',
      apiKeyMask: '（开发用，无需密钥）',
      health: 'healthy',
    },
    update: { health: 'healthy' },
    select: { id: true },
  });

  const modelKey = modelId.replace(/^mock/, 'mock-');
  const model = await prisma.model.upsert({
    where: { providerId_modelKey: { providerId: provider.id, modelKey } },
    create: {
      id: modelId,
      providerId: provider.id,
      modelKey,
      displayName: `Mock 模型 ${modelKey}`,
      capabilities: [],
      defaultParams: {},
    },
    update: {},
    select: { id: true },
  });

  mockModelRowCache.set(modelId, model.id);
  return model.id;
}

/** 重置缓存（测试用） */
export function __resetMockModelRowCache(): void {
  mockModelRowCache = null;
}
