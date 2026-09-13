/**
 * 模型服务商（Provider）与模型路由
 *
 * 对应技术文档第 30 条：**支持用户提供自己的模型 API**，
 * 且「模型调用和会员系统解耦」。
 *
 * ── 本模块最硬的一条约束 ──
 * **API Key 绝不出现在任何响应里**。
 * 写入时加密落库，读取时只返回掩码（如 `sk-****abcd`）。
 * 这不是「注意一下」的事情，而是通过「响应结构里根本没有该字段」来保证的：
 * 所有查询都用 `select` 显式挑字段，并统一经过 `toProviderView` 转换。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  BadRequestError,
  ConflictError,
  createModelProviderSchema,
  NotFoundError,
  paginate,
  updateModelProviderSchema,
  ValidationError,
  MODEL_PROVIDER_KINDS,
} from '@svh/domain';
import { SUPPORTED_PROVIDER_KINDS } from '@svh/model';
import {
  computeProviderConfigVersion,
  encryptSecret,
  MOCK_PROVIDER_ID,
  maskSecret,
  probeAllProviders,
  probeProvider,
  prisma,
  type Prisma,
} from '@svh/database';

import { getEnv } from '@svh/config';

import { getAgentModelRuntime, invalidateAgentModelRuntime } from '../core/agent-deps.js';
import { created, noContent, parseBody, parseIdParam, parseQuery } from '../core/validate.js';

/** Provider 列表查询参数 */
const listProvidersQuerySchema = z.object({
  enabled: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** 新增模型到 Provider */
const createModelSchema = z.object({
  modelKey: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  capabilities: z.array(z.string().max(64)).min(1),
  priority: z.number().int().min(0).max(1000).default(100),
  supportsStreaming: z.boolean().default(false),
  supportsAsync: z.boolean().default(false),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportedSizes: z.array(z.string().max(32)).default([]),
  maxDurationSeconds: z.number().positive().max(3600).optional(),
  unitCost: z.string().max(32).optional(),
  defaultParams: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

/** 连接测试请求 */
const testConnectionSchema = z.object({
  /**
   * 可选：用未保存的密钥做一次测试。
   * 这样用户可以在「保存前」先确认配置对不对。
   */
  apiKey: z.string().min(1).max(4000).optional(),
  baseUrl: z.string().url().max(2000).optional(),
});

/**
 * Provider 的对外视图 —— **绝不包含密钥字段**。
 *
 * 所有响应都必须经过这个函数，因此「忘记排除密钥」在结构上不可能发生。
 */
function toProviderView(
  row: {
    id: string;
    userId: string | null;
    name: string;
    kind: string;
    baseUrl: string;
    apiKeyMask: string;
    apiKeyEncrypted: string;
    headers: unknown;
    concurrency: number;
    rateLimitPerMinute: number | null;
    enabled: boolean;
    health: string;
    failureCount: number;
    lastCheckedAt: Date | null;
    config: unknown;
    createdAt: Date;
    updatedAt: Date;
  },
  modelCount: number,
) {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    /** 是否已配置密钥（不回显密钥本身） */
    hasApiKey: row.apiKeyEncrypted.length > 0,
    /** 掩码，供用户确认「是不是这把钥匙」 */
    apiKeyMask: row.apiKeyMask,
    headers: row.headers,
    concurrency: row.concurrency,
    rateLimitPerMinute: row.rateLimitPerMinute,
    enabled: row.enabled,
    health: row.health,
    failureCount: row.failureCount,
    lastCheckedAt: row.lastCheckedAt,
    config: row.config,
    modelCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  /*
   * ── 配置变更 → 让 Agent 侧的模型运行时缓存失效 ──
   *
   * `getAgentModelRuntime()`（apps/api/src/core/agent-deps.ts）把 Model Runtime
   * 缓存在模块级变量里，**不会自己过期**。不主动失效的话：用户在
   * `/settings/providers` 里配好了真实模型，Agent 对话仍会一直用进程启动时
   * 装配的那一份（通常是 Mock 回落），直到有人重启 API —— 用户视角就是
   * 「配置好了却还在返回占位文本」。
   *
   * Worker 侧有配置版本号轮询会自动重建（apps/worker/src/index.ts 的
   * CONFIG_REFRESH_INTERVAL_MS），API 侧此前没有对应机制，`invalidateAgentModelRuntime`
   * 导出了却无人调用。这里用一条 `onResponse` 钩子补上：本插件内**任何写方法**
   * 成功与否都失效缓存 —— 失败请求多失效一次只是下次请求重建一次运行时，
   * 代价可忽略，而漏掉某个写路由（新增/改模型这类子路由）会让缓存策略
   * 变成「有的变更生效、有的不生效」，那比不失效更难排查。
   */
  app.addHook('onResponse', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    invalidateAgentModelRuntime();
  });

  /** 支持的协议清单（前端渲染选项用） */
  app.get('/kinds', async () => ({
    items: MODEL_PROVIDER_KINDS.map((kind) => ({
      kind,
      label: PROVIDER_KIND_LABELS[kind] ?? kind,
      /** 是否有内置适配器；custom 需要用户自行实现 */
      builtin: (SUPPORTED_PROVIDER_KINDS as readonly string[]).includes(kind),
      /** 默认的 Base URL，方便用户填写 */
      defaultBaseUrl: DEFAULT_BASE_URLS[kind] ?? '',
    })),
  }));

  /** Provider 列表 */
  app.get('/', async (request) => {
    const query = parseQuery(request, listProvidersQuerySchema);

    const where = query.enabled !== undefined ? { enabled: query.enabled } : {};

    const [rows, total] = await Promise.all([
      prisma.modelProvider.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { models: true } } },
      }),
      prisma.modelProvider.count({ where }),
    ]);

    // 统一走 toProviderView，密钥字段在结构上不会泄漏
    const items = rows.map((row) => toProviderView(row, row._count.models));
    return paginate(items, total, { page: query.page, pageSize: query.pageSize });
  });

  /** 新增 Provider */
  app.post('/', async (request, reply) => {
    const input = parseBody(request, createModelProviderSchema);
    const env = getEnv();

    const existing = await prisma.modelProvider.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(`已存在同名的模型服务商「${input.name}」`, {
        userMessage: '已经有一个同名配置了，请换个名字。',
      });
    }

    // 加密落库；掩码单独保存供展示
    const encrypted = encryptSecret(input.apiKey, env.SECRET_ENCRYPTION_KEY);
    const mask = maskSecret(input.apiKey);

    const row = await prisma.modelProvider.create({
      data: {
        name: input.name,
        kind: input.kind,
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        apiKeyEncrypted: encrypted,
        apiKeyMask: mask,
        headers: (input.headers ?? {}) as Prisma.InputJsonValue,
        concurrency: input.concurrency,
        ...(input.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: input.rateLimitPerMinute }
          : {}),
        enabled: input.enabled,
        config: input.config as Prisma.InputJsonValue,
        // 新配置尚未验证，标记为 unknown 而不是假装健康
        health: 'unknown',
      },
      include: { _count: { select: { models: true } } },
    });

    return created(reply, toProviderView(row, row._count.models));
  });

  /** Provider 详情（含其模型列表） */
  app.get('/:id', async (request) => {
    const id = parseIdParam(request);

    const row = await prisma.modelProvider.findUnique({
      where: { id },
      include: { models: { orderBy: { priority: 'desc' } }, _count: { select: { models: true } } },
    });
    if (!row) {
      throw new NotFoundError(`模型服务商 ${id} 不存在`, {
        resourceLabel: '模型服务商',
        context: { providerId: id },
      });
    }

    return { ...toProviderView(row, row._count.models), models: row.models };
  });

  /** 更新 Provider（apiKey 省略表示不修改） */
  app.patch('/:id', async (request) => {
    const id = parseIdParam(request);
    const input = parseBody(request, updateModelProviderSchema);
    const env = getEnv();

    const existing = await prisma.modelProvider.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError(`模型服务商 ${id} 不存在`, {
        resourceLabel: '模型服务商',
        context: { providerId: id },
      });
    }

    // 只有传了 apiKey 才重新加密并更新掩码
    const keyPatch =
      input.apiKey !== undefined
        ? {
            apiKeyEncrypted: encryptSecret(input.apiKey, env.SECRET_ENCRYPTION_KEY),
            apiKeyMask: maskSecret(input.apiKey),
            // 换了密钥就把健康状态重置为待验证，避免沿用旧结论
            health: 'unknown',
            failureCount: 0,
            lastCheckedAt: null,
          }
        : {};

    // 改了 baseUrl 同样需要重新验证
    const urlPatch =
      input.baseUrl !== undefined && input.baseUrl !== existing.baseUrl
        ? { health: 'unknown', failureCount: 0, lastCheckedAt: null }
        : {};

    const row = await prisma.modelProvider.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.replace(/\/+$/, '') } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
        ...(input.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: input.rateLimitPerMinute }
          : {}),
        ...(input.headers !== undefined
          ? { headers: (input.headers ?? {}) as Prisma.InputJsonValue }
          : {}),
        ...(input.config !== undefined ? { config: input.config as Prisma.InputJsonValue } : {}),
        ...keyPatch,
        ...urlPatch,
      },
      include: { _count: { select: { models: true } } },
    });

    return toProviderView(row, row._count.models);
  });

  /** 删除 Provider（级联删除其模型与调用记录） */
  app.delete('/:id', async (request, reply) => {
    const id = parseIdParam(request);

    const existing = await prisma.modelProvider.findUnique({
      where: { id },
      select: { id: true, name: true, kind: true },
    });
    if (!existing) {
      throw new NotFoundError(`模型服务商 ${id} 不存在`, {
        resourceLabel: '模型服务商',
        context: { providerId: id },
      });
    }

    // 系统内置的 Mock Provider 不允许删除：删掉会让开发环境无模型可用
    if (existing.kind === 'mock') {
      throw new BadRequestError('内置的 Mock 服务商不能删除', {
        userMessage: '这是开发用的内置服务商，无法删除。',
        suggestions: ['如需停用可将其关闭'],
      });
    }

    await prisma.modelProvider.delete({ where: { id } });
    return noContent(reply);
  });

  /**
   * 连通性测试。
   *
   * 两种用法：
   * 1. 测试已保存的配置（不传 apiKey）
   * 2. 保存前先试一下（传 apiKey / baseUrl），避免存下一个错的配置
   */
  app.post('/:id/test', async (request) => {
    const id = parseIdParam(request);
    const input = parseBody(request, testConnectionSchema);
    const env = getEnv();

    const row = await prisma.modelProvider.findUnique({
      where: { id },
      include: { _count: { select: { models: true } } },
    });
    if (!row) {
      throw new NotFoundError(`模型服务商 ${id} 不存在`, {
        resourceLabel: '模型服务商',
        context: { providerId: id },
      });
    }

    // 未保存的临时配置：纯内存覆写后探测。
    // 刻意不写数据库 —— 早期实现是「临时覆写 + 探测 + 回滚」，
    // 那样在并发下会让正在进行的真实调用短暂拿到错误的凭据。
    if (input.apiKey !== undefined || input.baseUrl !== undefined) {
      const result = await probeProvider(id, {
        encryptionKey: env.SECRET_ENCRYPTION_KEY,
        override: {
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.replace(/\/+$/, '') } : {}),
        },
        // 临时凭据的探测结果不代表已保存配置的健康度，不写回
        persistHealth: false,
      });

      return { ...result, usedTemporaryConfig: true };
    }

    const result = await probeProvider(id, { encryptionKey: env.SECRET_ENCRYPTION_KEY });
    return { ...result, usedTemporaryConfig: false };
  });

  /** 测试全部 Provider（保存多个配置后做一次总检） */
  app.post('/test-all', async () => {
    const env = getEnv();
    const results = await probeAllProviders({ encryptionKey: env.SECRET_ENCRYPTION_KEY });
    return {
      items: results,
      healthy: results.filter((r) => r.health === 'healthy').length,
      total: results.length,
    };
  });

  /** 配置版本号：前端可据此判断是否需要刷新模型列表 */
  app.get('/config-version', async () => {
    return { version: await computeProviderConfigVersion() };
  });

  /**
   * 模型运行时状态。
   *
   * ── 这个端点补的是哪个洞 ──
   * 没有可用的真实模型时，链路会改用 Mock：Agent 照常回复、任务照常执行，
   * 只是产出全是占位数据。界面此前拿不到任何信号，用户会把「示例文本-878」
   * 当成模型答复 —— 这正是 spec §10 第 4 条禁止的静默失败。
   *
   * ── 判据为什么不是 `runtime.usingMock` ──
   * 那是**踩过的坑**。`usingMock` 只表示「一个可用模型都没有，装配层加了内置
   * Mock 兜底」；而库里那条 `kind='mock'` 的 Mock Provider 行（开发期遗留）
   * **自己就带 5 个模型**，于是「只剩 Mock 可用」时 `usingMock` 依然是 `false`。
   * 实测：把唯一一个真实 Provider 禁用后，端点照样报 `usingMock: false`，
   * 界面上的提示条根本不会出现 —— 信号选错了，等于没修。
   *
   * 界面要回答的问题是「产出会不会是占位内容」，所以按 **Provider 类型** 算：
   * 所有可用模型都来自 mock 类 Provider（或内置的 `provider_mock`）
   * → 一定是占位内容。这个判据同时覆盖了「一个模型都没有」的情形。
   */
  app.get('/runtime', async (request) => {
    const runtime = await getAgentModelRuntime(request.log);

    const providerKindById = new Map(runtime.providers.map((p) => [p.providerId, p.kind]));
    const realModelCount = runtime.models.filter((model) => {
      const kind = providerKindById.get(model.providerId);
      return kind !== 'mock' && model.providerId !== MOCK_PROVIDER_ID;
    }).length;

    return {
      placeholderOnly: realModelCount === 0,
      realModelCount,
      providerCount: runtime.providers.length,
      modelCount: runtime.models.length,
    };
  });

  /* ── 模型管理 ── */

  /** 为 Provider 新增模型 */
  app.post('/:id/models', async (request, reply) => {
    const providerId = parseIdParam(request);
    const input = parseBody(request, createModelSchema);

    const provider = await prisma.modelProvider.findUnique({
      where: { id: providerId },
      select: { id: true },
    });
    if (!provider) {
      throw new NotFoundError(`模型服务商 ${providerId} 不存在`, {
        resourceLabel: '模型服务商',
        context: { providerId },
      });
    }

    const duplicate = await prisma.model.findUnique({
      where: { providerId_modelKey: { providerId, modelKey: input.modelKey } },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError(`该服务商下已存在模型标识「${input.modelKey}」`, {
        userMessage: '这个模型已经添加过了。',
      });
    }

    // 能力取值必须是领域枚举中的合法值，否则 Model Router 永远选不中它
    const invalidCapabilities = input.capabilities.filter(
      (capability) => !VALID_CAPABILITIES.includes(capability),
    );
    if (invalidCapabilities.length > 0) {
      throw new ValidationError(`不支持的能力标识：${invalidCapabilities.join('、')}`, {
        userMessage: `以下能力标识无效：${invalidCapabilities.join('、')}`,
        suggestions: [`可用能力：${VALID_CAPABILITIES.join('、')}`],
      });
    }

    const model = await prisma.model.create({
      data: {
        providerId,
        modelKey: input.modelKey,
        displayName: input.displayName,
        capabilities: input.capabilities as never,
        priority: input.priority,
        supportsStreaming: input.supportsStreaming,
        supportsAsync: input.supportsAsync,
        ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        supportedSizes: input.supportedSizes,
        ...(input.maxDurationSeconds !== undefined
          ? { maxDurationSeconds: input.maxDurationSeconds }
          : {}),
        ...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
        defaultParams: input.defaultParams as Prisma.InputJsonValue,
        enabled: input.enabled,
      },
    });

    return created(reply, model);
  });

  /** 更新模型 */
  app.patch('/:id/models/:modelId', async (request) => {
    const params = request.params as { id?: string; modelId?: string };
    const providerId = params.id ?? '';
    const modelId = params.modelId ?? '';

    const input = parseBody(request, createModelSchema.partial());

    const existing = await prisma.model.findFirst({
      where: { id: modelId, providerId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError(`模型 ${modelId} 不存在于该服务商下`, {
        resourceLabel: '模型',
        context: { providerId, modelId },
      });
    }

    if (input.capabilities !== undefined) {
      const invalid = input.capabilities.filter((c) => !VALID_CAPABILITIES.includes(c));
      if (invalid.length > 0) {
        throw new ValidationError(`不支持的能力标识：${invalid.join('、')}`);
      }
    }

    return prisma.model.update({
      where: { id: modelId },
      data: {
        ...(input.modelKey !== undefined ? { modelKey: input.modelKey } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.capabilities !== undefined ? { capabilities: input.capabilities as never } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.supportsStreaming !== undefined
          ? { supportsStreaming: input.supportsStreaming }
          : {}),
        ...(input.supportsAsync !== undefined ? { supportsAsync: input.supportsAsync } : {}),
        ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.supportedSizes !== undefined ? { supportedSizes: input.supportedSizes } : {}),
        ...(input.maxDurationSeconds !== undefined
          ? { maxDurationSeconds: input.maxDurationSeconds }
          : {}),
        ...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
        ...(input.defaultParams !== undefined
          ? { defaultParams: input.defaultParams as Prisma.InputJsonValue }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
  });

  /** 删除模型 */
  app.delete('/:id/models/:modelId', async (request, reply) => {
    const params = request.params as { id?: string; modelId?: string };
    const providerId = params.id ?? '';
    const modelId = params.modelId ?? '';

    const deleted = await prisma.model.deleteMany({ where: { id: modelId, providerId } });
    if (deleted.count === 0) {
      throw new NotFoundError(`模型 ${modelId} 不存在于该服务商下`, {
        resourceLabel: '模型',
        context: { providerId, modelId },
      });
    }
    return noContent(reply);
  });
}

/** 协议的中文名与默认地址（减少用户填写负担，也避免常见笔误） */
const PROVIDER_KIND_LABELS: Record<string, string> = {
  openai_compatible: 'OpenAI 兼容',
  anthropic_compatible: 'Anthropic（Claude）',
  gemini_compatible: 'Google Gemini',
  mock: 'Mock（开发用）',
  custom: '自定义协议',
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai_compatible: 'https://api.openai.com/v1',
  anthropic_compatible: 'https://api.anthropic.com/v1',
  gemini_compatible: 'https://generativelanguage.googleapis.com/v1beta',
  mock: 'mock://local',
};

/** 合法的能力标识（与 @svh/domain 的 MODEL_CAPABILITIES 保持一致） */
const VALID_CAPABILITIES: readonly string[] = [
  'text',
  'script',
  'image',
  'image_edit',
  'video',
  'video_extend',
  'audio',
  'voice',
  'music',
  'digital_human',
  'subtitle',
  'embedding',
];
