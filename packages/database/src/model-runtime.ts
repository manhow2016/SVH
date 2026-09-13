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
 * 某个 Provider 是否属于「占位 / 模拟」类。
 *
 * 判据取两处：`kind === 'mock'`，以及固定的 `MOCK_PROVIDER_ID`。
 * 后者是**双保险** —— 占位行的 `kind` 被写错过（早先是 `'custom'`，
 * 那是个没有适配器的种类），只认 kind 的话，写错一次就会让下面的判据失效。
 */
function isMockProvider(providerId: string, providerKind: ReadonlyMap<string, string>): boolean {
  return providerId === MOCK_PROVIDER_ID || providerKind.get(providerId) === 'mock';
}

/**
 * 是否需要回落内置 Mock。
 *
 * ── 判据为什么不能是 `models.length === 0` ──
 * `resolveModelRowId` 为了满足 `model_tasks.modelId` 的外键，会在**首次 Mock
 * 调用之后**往库里写一条占位 Provider 与它的模型行。按长度判断的话，那一次
 * 写入会让此后每一次装配都「发现有模型」而不再回落 —— 可那些占位行的
 * `capabilities` 是空的、Provider 当时也没有适配器（`kind: 'custom'`），
 * **一个请求都服务不了**。结果就是「空库跑一次 Mock，链路从此再也起不来」，
 * 必须手工删库才能恢复。这条单向棘轮是实测出来的。
 *
 * 所以按 **Provider 类型**判断：只要没有非 mock 类的模型，就必须回落。
 * 这与 `GET /api/models/providers/runtime` 的 `placeholderOnly` 是同一个判据。
 *
 * 抽成导出函数是为了能脱离数据库把这条不变量钉住 —— 它一旦退回按长度判断，
 * 整个链路会在「空库跑过一次」之后静默失效，而那种失效很难归因。
 */
export function needsMockFallback(
  models: ReadonlyArray<{ providerId: string }>,
  providerKind: ReadonlyMap<string, string>,
  forceMock = false,
): boolean {
  if (forceMock) return true;
  return !models.some((model) => !isMockProvider(model.providerId, providerKind));
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
  /** providerId → kind，供「有没有真实模型」的判据使用 */
  const providerKind = new Map<string, string>();

  if (!forceMock) {
    // 读取真实 Provider 配置
    const rows = await prisma.modelProvider.findMany({
      where: { enabled: true },
      include: { models: { where: { enabled: true } } },
    });

    for (const row of rows) {
      providerKind.set(row.id, row.kind);
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

  const fallbackToMock = needsMockFallback(models, providerKind, forceMock);

  // 真实 Provider 的适配器（OpenAI 兼容 / Anthropic / Gemini）。
  // 这三个协议与 Mock 的 kind 互不重叠，因此可以同时注册：
  // 有真实模型时用真实的，没有时用 Mock 兜底。
  adapters.push(...createDefaultAdapters());

  let usingMock = false;
  if (fallbackToMock) {
    /*
     * 先把库里那些 mock 类占位行摘掉，再用内置目录填上。
     *
     * 不摘的话会出现两个同 id 的 Provider（库行 + 内置），且库里那份的
     * `capabilities` 是空的 —— 同 id 的重复条目除了让人看不懂，还让
     * 「哪些模型真的能用」变得没有答案。内置目录才是唯一可信的 Mock 清单。
     */
    for (let i = providers.length - 1; i >= 0; i -= 1) {
      if (providers[i]?.providerId === MOCK_PROVIDER_ID) providers.splice(i, 1);
    }
    for (let i = models.length - 1; i >= 0; i -= 1) {
      if (models[i]?.providerId === MOCK_PROVIDER_ID) models.splice(i, 1);
    }

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
 *
 * ── 这行只为了外键完整性，不该被当成模型目录 ──
 * 它是**副作用**写进去的，因此装配层不能拿它当作「库里有模型」的证据 ——
 * 那正是「空库跑一次 Mock 之后链路再也起不来」的单向棘轮的成因。
 * 装配层的判据已按 Provider 类型排除 mock（见 `buildModelRuntime`），
 * 这里则负责把落库的数据写**诚实**，别留下会误导人的字段。
 */
let mockModelRowCache: Map<string, string> | null = null;

/** 内置 Mock 目录的 modelId → 描述，用于把占位行写成与内存目录一致的形状 */
function mockCatalogById(): Map<string, ModelDescriptor> {
  return new Map(buildMockModels().map((model) => [model.modelId, model]));
}

/** 导出供测试：占位行的形状（kind / capabilities）必须被守住 */
export async function resolveModelRowId(modelId: string): Promise<string> {
  if (!modelId.startsWith('mock')) return modelId;

  if (mockModelRowCache === null) mockModelRowCache = new Map();
  const cached = mockModelRowCache.get(modelId);
  if (cached !== undefined) return cached;

  /*
   * `kind` 必须是 `'mock'` 而不是 `'custom'`。
   *
   * 早先写的是 `custom`，而 `custom` **没有内置适配器** —— 于是这行不仅让装配层
   * 误判「有模型」，它自己还是个谁也服务不了的 Provider。
   * `update` 分支同样要改，否则历史行永远停在错误的值上。
   */
  const provider = await prisma.modelProvider.upsert({
    where: { id: MOCK_PROVIDER_ID },
    create: {
      id: MOCK_PROVIDER_ID,
      name: MOCK_PROVIDER_NAME,
      kind: 'mock',
      baseUrl: 'mock://local',
      apiKeyEncrypted: '',
      apiKeyMask: '（开发用，无需密钥）',
      health: 'healthy',
    },
    update: { health: 'healthy', kind: 'mock' },
    select: { id: true },
  });

  /*
   * modelKey 与 capabilities 都取自内置目录。
   *
   * 早先用 `modelId.replace(/^mock/, 'mock-')` 推导 modelKey，把 `mocktextv1`
   * 变成 `mock-mocktextv1` —— 既不是目录里的 `mock-text-v1`，又会随调用次数
   * 累积出 `mock-mock-mocktextv1` 这类永远没人认识的键（库里就躺着两条这样的行）。
   * capabilities 早先写死 `[]`，让这些行彻底无法被路由选中。
   */
  const catalogEntry = mockCatalogById().get(modelId);
  const modelKey = catalogEntry?.modelKey ?? modelId;
  // 展开成可变数组：Prisma 的入参类型不接受 readonly
  const capabilities: ModelCapability[] = [...(catalogEntry?.capabilities ?? [])];
  const displayName = catalogEntry?.displayName ?? `Mock 模型 ${modelKey}`;

  /*
   * 先按 `id` 找，再按 `modelKey` 找 —— 两种历史形态都要认得出来。
   *
   * 早先的 `modelId.replace(/^mock/, 'mock-')` 把 modelKey 写坏过（库里躺着
   * `mock-mocktextv1` 这种没人认识的键），而行的 `id` 恰好等于 modelId。
   * 如果只按（修正后的）modelKey 查，就会走到 `create`，而 `create` 里
   * `id: modelId` 会和那条历史行**撞主键** —— 修一个 bug 换来一个崩溃。
   */
  const existing =
    (await prisma.model.findFirst({
      where: { providerId: provider.id, id: modelId },
      select: { id: true },
    })) ??
    (await prisma.model.findFirst({
      where: { providerId: provider.id, modelKey },
      select: { id: true },
    }));

  const model =
    existing === null
      ? await prisma.model.create({
          data: {
            id: modelId,
            providerId: provider.id,
            modelKey,
            displayName,
            capabilities,
            defaultParams: {},
          },
          select: { id: true },
        })
      : // 历史行就地修正 capabilities；modelKey 不动 ——
        // 它只影响可读性，而改键有撞唯一约束的风险，不值得为一行外键锚点冒
        await prisma.model.update({
          where: { id: existing.id },
          data: { capabilities, displayName },
          select: { id: true },
        });

  mockModelRowCache.set(modelId, model.id);
  return model.id;
}

/** 重置缓存（测试用） */
export function __resetMockModelRowCache(): void {
  mockModelRowCache = null;
}
