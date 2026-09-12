/**
 * Provider 健康检查与运行时刷新
 *
 * ── 为什么要主动探活，而不只靠调用失败 ──
 * 「连续失败 N 次后降级」只能在**已经失败过**之后起作用。
 * 用户配置完 API Key 后并不知道能不能用，直到第一次生成失败。
 * 因此需要主动探测：保存配置时立刻测一次，用户当场就知道配对了没有。
 *
 * ── 降级阈值 ──
 * 单次失败可能是网络抖动，因此不立即判死。达到阈值后标记为 `down`，
 * Model Router 的候选排序会把 `down` 的 Provider 直接排除，
 * 从而自动切换到备用模型（技术文档第 67 条）。
 */
import type { ProviderHealth } from '@svh/domain';
import { hasBuiltinAdapter } from '@svh/model';

import { prisma } from './client.js';
import { decryptSecret } from './crypto.js';
import { buildModelRuntime, type ModelRuntime } from './model-runtime.js';

/**
 * 连续失败多少次后标记为 down。
 * 取 3：既能容忍瞬时抖动，又不会让用户等太久。
 */
export const DEGRADED_AFTER_FAILURES = 2;
export const DOWN_AFTER_FAILURES = 3;

/** 单次探测结果 */
export interface HealthProbeResult {
  providerId: string;
  providerName: string;
  /** 探测到的健康状态 */
  health: ProviderHealth;
  /** 面向用户的说明；成功时为 null */
  message: string | null;
  /** 建议的处置方式 */
  suggestions: string[];
  latencyMs: number;
  /** 已配置的模型数量 */
  modelCount: number;
}

/** 由连续失败次数推导健康状态 */
export function deriveHealth(failureCount: number): ProviderHealth {
  if (failureCount >= DOWN_AFTER_FAILURES) return 'down';
  if (failureCount >= DEGRADED_AFTER_FAILURES) return 'degraded';
  if (failureCount === 0) return 'healthy';
  return 'unknown';
}

/**
 * 探测单个 Provider 的连通性。
 *
 * 会真的发一次最小请求（用 `ProviderAdapter.checkHealth`）。
 * 探测失败**不会**抛错 —— 它本身就是用来发现失败的。
 */
export async function probeProvider(
  providerId: string,
  options: {
    encryptionKey: string;
    /**
     * 用未保存的临时凭据做探测。
     *
     * 为什么需要它：用户在设置页填完 API Key 后应当能**保存前**先测一次。
     * 早期实现是「临时覆写数据库 → 探测 → 回滚」，但那样在并发下会让
     * 正在进行的真实调用短暂用到错误的凭据。改为纯内存覆写后，
     * 数据库始终是干净状态。
     */
    override?: { apiKey?: string; baseUrl?: string };
    /** 临时凭据探测时不写回健康状态（避免污染已保存配置的状态） */
    persistHealth?: boolean;
  },
): Promise<HealthProbeResult> {
  const shouldPersist = options.persistHealth ?? true;
  const row = await prisma.modelProvider.findUnique({
    where: { id: providerId },
    include: { _count: { select: { models: true } } },
  });

  if (!row) {
    return {
      providerId,
      providerName: '(不存在)',
      health: 'down',
      message: '模型服务商不存在或已被删除。',
      suggestions: ['刷新页面后重试'],
      latencyMs: 0,
      modelCount: 0,
    };
  }

  const base: Omit<HealthProbeResult, 'health' | 'message' | 'suggestions' | 'latencyMs'> = {
    providerId: row.id,
    providerName: row.name,
    modelCount: row._count.models,
  };

  // Mock Provider 无需探测
  if (row.kind === 'mock') {
    if (shouldPersist) await updateProviderHealth(row.id, 'healthy');
    return {
      ...base,
      health: 'healthy',
      message: null,
      suggestions: [],
      latencyMs: 0,
    };
  }

  if (!hasBuiltinAdapter(row.kind)) {
    // custom 协议需要用户自己实现适配器，无法代其探测
    if (shouldPersist) await updateProviderHealth(row.id, 'unknown');
    return {
      ...base,
      health: 'unknown',
      message: '自定义协议的适配器尚未接入，无法自动检测连通性。',
      suggestions: ['确认已在代码中注册该协议的适配器'],
      latencyMs: 0,
    };
  }

  // 解密密钥（临时凭据优先）
  let apiKey: string | null = options.override?.apiKey ?? null;
  if (apiKey === null && row.apiKeyEncrypted.length > 0) {
    try {
      apiKey = decryptSecret(row.apiKeyEncrypted, options.encryptionKey);
    } catch {
      if (shouldPersist) await updateProviderHealth(row.id, 'down');
      return {
        ...base,
        health: 'down',
        message: '无法解密已保存的 API Key（加密密钥可能已更换）。',
        suggestions: ['重新填写 API Key'],
        latencyMs: 0,
      };
    }
  }

  if (apiKey === null) {
    if (shouldPersist) await updateProviderHealth(row.id, 'down');
    return {
      ...base,
      health: 'down',
      message: '尚未配置 API Key。',
      suggestions: ['在设置中填写 API Key'],
      latencyMs: 0,
    };
  }

  const startedAt = Date.now();
  const { createAdapterFor } = await import('@svh/model');
  const adapter = createAdapterFor(row.kind);

  if (adapter?.checkHealth === undefined) {
    await updateProviderHealth(row.id, 'unknown');
    return {
      ...base,
      health: 'unknown',
      message: '该协议未实现连通性检测。',
      suggestions: [],
      latencyMs: Date.now() - startedAt,
    };
  }

  const health = await adapter.checkHealth(
    {
      providerId: row.id,
      name: row.name,
      kind: row.kind,
      // 临时凭据优先：测试未保存的配置时不接触数据库
      baseUrl: options.override?.baseUrl ?? row.baseUrl,
      headers: (row.headers ?? {}) as Record<string, string>,
      config: (row.config ?? {}) as Record<string, unknown>,
      concurrency: row.concurrency,
      rateLimitPerMinute: row.rateLimitPerMinute,
      enabled: row.enabled,
    },
    apiKey,
  );

  const latencyMs = Date.now() - startedAt;
  if (shouldPersist) await updateProviderHealth(row.id, health);

  return {
    ...base,
    health,
    latencyMs,
    message: health === 'healthy' ? null : describeHealthProblem(health),
    suggestions: health === 'healthy' ? [] : suggestForHealth(health),
  };
}

/** 探测全部 Provider（保存配置后可用它做一次总检） */
export async function probeAllProviders(options: { encryptionKey: string }): Promise<HealthProbeResult[]> {
  const rows = await prisma.modelProvider.findMany({
    where: { enabled: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  const results: HealthProbeResult[] = [];
  for (const row of rows) {
    results.push(await probeProvider(row.id, options));
  }
  return results;
}

/**
 * 写回健康状态。
 *
 * 探测成功时**把 failureCount 归零** —— 否则一旦降级就再也回不到 healthy，
 * 这是很容易漏掉的一点。
 */
export async function updateProviderHealth(
  providerId: string,
  health: ProviderHealth,
): Promise<void> {
  const isHealthy = health === 'healthy';

  await prisma.modelProvider.update({
    where: { id: providerId },
    data: {
      health,
      lastCheckedAt: new Date(),
      ...(isHealthy ? { failureCount: 0 } : {}),
    },
  });
}

/**
 * 记录一次**调用失败**，并按阈值推进健康状态。
 *
 * 与主动探活互补：调用失败是真实流量给出的信号，
 * 比探活更能反映「这个 Provider 现在能不能用」。
 */
export async function recordProviderFailure(
  providerId: string,
  options: { errorCode?: string } = {},
): Promise<ProviderHealth> {
  const row = await prisma.modelProvider.findUnique({
    where: { id: providerId },
    select: { failureCount: true, kind: true },
  });
  if (!row) return 'unknown';

  // 凭据类错误（401/403）不是「抖动」，直接判 down，不必等阈值
  const isCredentialError =
    options.errorCode === 'MODEL_NOT_CONFIGURED' || options.errorCode === 'MODEL_CONTENT_REJECTED';
  const nextCount = row.failureCount + 1;
  const health: ProviderHealth = isCredentialError ? 'down' : deriveHealth(nextCount);

  await prisma.modelProvider.update({
    where: { id: providerId },
    data: {
      failureCount: nextCount,
      health,
      lastCheckedAt: new Date(),
    },
  });

  return health;
}

/** 记录一次调用成功：清空失败计数并恢复 healthy */
export async function recordProviderSuccess(providerId: string): Promise<void> {
  await prisma.modelProvider.updateMany({
    where: { id: providerId },
    data: { failureCount: 0, health: 'healthy', lastCheckedAt: new Date() },
  });
}

function describeHealthProblem(health: ProviderHealth): string {
  switch (health) {
    case 'down':
      return '无法连接到该模型服务，或 API Key 无效。';
    case 'degraded':
      return '该模型服务响应异常（可能被限流或部分接口不可用）。';
    default:
      return '暂时无法确认该模型服务的状态。';
  }
}

function suggestForHealth(health: ProviderHealth): string[] {
  switch (health) {
    case 'down':
      return ['检查 API Key 是否正确', '检查 Base URL 是否可达', '确认账号额度是否充足'];
    case 'degraded':
      return ['稍后重试', '检查是否触发限流'];
    default:
      return ['执行一次生成以确认可用性'];
  }
}

/* -------------------------------------------------------------------------- */
/* 运行时刷新                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Provider 配置的版本标记。
 *
 * 用「最近一次更新时间 + 数量」作为轻量版本号：
 * Worker 周期性比对它，发现变化就重建 Model Router。
 * 这样用户在设置里改完配置后，正在运行的 Worker 会自动生效，
 * 不需要重启进程，也不需要引入额外的消息通道。
 */
export async function computeProviderConfigVersion(): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.modelProvider.aggregate({ _max: { updatedAt: true } }),
    prisma.modelProvider.count(),
  ]);
  const latest = aggregate._max.updatedAt?.getTime() ?? 0;
  return `${count}:${latest}`;
}

/**
 * 判断运行时是否需要重建。
 *
 * 只有配置真的变了才重建 —— 重建会重新查询数据库并构造对象，
 * 无脑每分钟重建会浪费资源。
 */
export async function needsRuntimeRefresh(currentVersion: string): Promise<boolean> {
  return (await computeProviderConfigVersion()) !== currentVersion;
}

/** 重新装配模型运行时（配置变更后调用） */
export async function refreshModelRuntime(
  options: Parameters<typeof buildModelRuntime>[0],
): Promise<ModelRuntime> {
  return buildModelRuntime(options);
}
