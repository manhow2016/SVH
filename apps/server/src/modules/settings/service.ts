import { and, eq, isNull } from "drizzle-orm";
import { settings as settingsTable, type SVHDatabase } from "@svh/database";
import type { ModelConfig } from "@svh/providers";
import type { LLMEnvConfig } from "../../config/index";
import { ERRORS } from "../../lib/errors";
import type { ModelService } from "./model-service";
import {
  MODEL_PROVIDERS,
  MODEL_TYPES,
  getProviderMeta,
  resolveRuntimeBaseUrl,
  type ModelProviderMeta,
  type ModelType,
  type ProviderApiKey,
} from "./model-catalog";
import {
  verifyOpenAICompatibleKey,
  type ProviderVerifyOutcome,
} from "./provider-verify";

/** 模型设置（服务端内部，含 API Key）：按供应商保存 API Key（文本/图片/视频/音频共用）
 * enabledModels：用户启用的模型 id 列表（null = 全部启用；管理员全局 enabled 之上的用户级选择） */
export interface ModelSettings {
  providers: Record<string, ProviderApiKey>;
  enabledModels: string[] | null;
}

/** 供应商 + 设置视图（前端展示）：API Key 不直出（仅 hasApiKey），附可用模型列表 */
export interface ProviderSettingsView extends ModelProviderMeta {
  hasApiKey: boolean;
  models: Array<{ id: string; modelName: string; type: string; displayName: string }>;
}

/** 设置总视图（GET /api/settings 返回）：目录元数据 + 供应商 Key 掩码 + 可用模型 + 用户启用列表 */
export interface SettingsView {
  catalog: { providers: ModelProviderMeta[]; types: typeof MODEL_TYPES };
  providers: ProviderSettingsView[];
  enabledModels: string[] | null;
}

const SETTINGS_KEY = "model";

/**
 * Settings 服务（文档 §37 数据隔离：按用户存储）。
 *
 * 模型设置（V3）：供应商 API Key（模型列表由管理员在 models 表维护，用户只读）。
 * 查找顺序：用户配置 Key → 环境变量默认 Key（SVH_LLM_API_KEY 兜底）。
 */
export class SettingsService {
  constructor(
    private readonly db: SVHDatabase,
    private readonly envDefaults: LLMEnvConfig,
    private readonly modelService: ModelService,
  ) {}

  /** 前端设置视图（供应商掩码 + 各供应商可用模型） */
  async getSettingsView(userId: string): Promise<SettingsView> {
    const s = await this.getModelSettings(userId);
    const grouped = await this.modelService.listEnabledGrouped();
    const providers: ProviderSettingsView[] = MODEL_PROVIDERS.map((meta) => ({
      ...meta,
      hasApiKey: (s.providers[meta.id]?.apiKey ?? "") !== "",
      models: grouped[meta.id] ?? [],
    }));
    return { catalog: { providers: MODEL_PROVIDERS, types: MODEL_TYPES }, providers, enabledModels: s.enabledModels };
  }

  /** 获取生效的模型设置（用户配置优先，最后 env 兜底） */
  async getModelSettings(userId: string): Promise<ModelSettings> {
    const saved = (await this.loadRow(SETTINGS_KEY, userId)) as {
      providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
      enabledModels?: string[] | null;
    } | null;

    const providers: Record<string, ProviderApiKey> = {};
    for (const [id, v] of Object.entries(saved?.providers ?? {})) {
      // 兼容旧数据：仅保留存在供应商的 API Key（旧 custom 等已移除供应商不再使用）
      if (getProviderMeta(id) && typeof v.apiKey === "string") {
        providers[id] = { apiKey: v.apiKey };
      }
    }
    // 收敛用户启用列表：过滤已失效的模型 id（管理员删除/替换模型后的历史引用）。
    // 过滤后为空等同「全部启用」（与旧数据语义一致，空数组 = null）。
    const rawEnabledModels =
      Array.isArray(saved?.enabledModels) && saved.enabledModels.length > 0
        ? saved.enabledModels.filter((id): id is string => typeof id === "string")
        : [];
    const filtered =
      rawEnabledModels.length > 0
        ? await this.modelService.filterExistingIds(rawEnabledModels)
        : [];
    const enabledModels = filtered.length > 0 ? filtered : null;
    return { providers, enabledModels };
  }

  /** 更新模型设置并持久化（API Key 与用户级启用列表可局部更新） */
  async updateModelSettings(
    userId: string,
    partial: {
      providers?: Record<string, Partial<ProviderApiKey>>;
      enabledModels?: string[] | null;
    },
  ): Promise<ModelSettings> {
    const current = await this.getModelSettings(userId);
    const providers: Record<string, ProviderApiKey> = { ...current.providers };
    for (const [id, patch] of Object.entries(partial.providers ?? {})) {
      const meta = getProviderMeta(id);
      if (!meta) continue;
      providers[id] = { apiKey: patch.apiKey !== undefined ? patch.apiKey : providers[id]?.apiKey ?? "" };
    }

    // 用户级启用列表（null = 全部启用）。
    // 模型可能已被管理员删除/替换（如 qwen-max → qwen3.8-flash），历史引用静默收敛，
    // 避免用户因残留 id 无法保存设置（原实现直接报错「模型不存在」）。
    let enabledModels = current.enabledModels;
    if (partial.enabledModels !== undefined) {
      const ids = partial.enabledModels;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        throw ERRORS.INVALID_INPUT("enabledModels must be an array of model ids");
      }
      const existingIds =
        ids.length > 0 ? await this.modelService.filterExistingIds(ids) : [];
      enabledModels = existingIds.length > 0 ? existingIds : null;
    }

    const next: ModelSettings = { providers, enabledModels };
    await this.save(SETTINGS_KEY, userId, next);
    return next;
  }

  /**
   * 由会话模型配置 + 用户生效设置构造 ModelConfig（文档 §11）。
   * V0.3：模型由系统决定——显式模型名（会话残留）一律忽略，取默认文本模型。
   */
  async getEffectiveModelConfig(
    session: { modelId: string },
    userId: string,
  ): Promise<ModelConfig> {
    const s = await this.getModelSettings(userId);
    const resolved = await this.modelService.resolveModel(undefined, null, undefined, undefined, this.keyedProviders(s));
    return this.buildModelConfig(resolved, s);
  }

  /**
   * 技能模型配置：按技能允许的类型集合解析模型（显式 modelName 或默认模型），
   * API Key / baseUrl 解析逻辑与 getEffectiveModelConfig 一致。
   * V0.3：用户不再启停模型（userEnabledIds = null 系统决定；已配 Key 供应商优先）。
   */
  async getSkillModelConfig(
    modelName: string | undefined,
    userId: string,
    types: ModelType[],
    tier?: string,
  ): Promise<ModelConfig> {
    const s = await this.getModelSettings(userId);
    const resolved = await this.modelService.resolveModel(modelName, null, types, tier, this.keyedProviders(s));
    return this.buildModelConfig(resolved, s);
  }

  /**
   * 技能模型配置（含目录供应商标识，生成服务用于记录资产来源 providerId）。
   * tier = 生成方案档位（economy/balanced/quality）：指定时由系统按档位选模型。
   */
  async getSkillModelConfigWithMeta(
    modelName: string | undefined,
    userId: string,
    types: ModelType[],
    tier?: string,
  ): Promise<{ config: ModelConfig; providerId: string; type: ModelType }> {
    const s = await this.getModelSettings(userId);
    const resolved = await this.modelService.resolveModel(modelName, null, types, tier, this.keyedProviders(s));
    return { config: this.buildModelConfig(resolved, s), providerId: resolved.providerId, type: resolved.type };
  }

  /**
   * 验证供应商 API Key（用户视角：无用户 Key 且未传待测 Key 时返回 no_key，
   * 不落库、不改动设置，仅用于前端状态图标检测）。
   *
   * @param providerId 供应商 id（白名单校验）
   * @param apiKeyOverride 待测 Key（前端编辑框草稿）；未传则用用户已保存的 Key
   */
  async verifyProviderKey(
    userId: string,
    providerId: string,
    apiKeyOverride?: string,
  ): Promise<ProviderVerifyOutcome> {
    const meta = getProviderMeta(providerId);
    if (!meta) throw ERRORS.INVALID_INPUT(`unknown provider: ${providerId}`);

    const settings = await this.getModelSettings(userId);
    const stored = settings.providers[providerId]?.apiKey ?? "";
    const apiKey = (apiKeyOverride ?? "").trim() || stored;
    if (apiKey === "") {
      return { ok: false, status: "no_key", message: "未配置 API Key" };
    }

    // 验证语义：直达供应商真实端点（判断 Key 在供应商平台是否有效）。
    // 不应用运行时 env 覆盖（SVH_LLM_BASE_URL 用于内网网关 / mock 模拟调用场景，
    // 若验证也跟随 env，会被 mock 等模拟端点短路，无法发现无效 Key）
    const baseUrl = meta.baseUrl;
    // 降级 chat 验证用模型：该供应商任一启用模型（优先文本）
    const providerModels = (await this.modelService.listEnabledGrouped())[providerId] ?? [];
    const chatModelName =
      providerModels.find((m) => m.type === "text")?.modelName ?? providerModels[0]?.modelName;
    return verifyOpenAICompatibleKey({ baseUrl, apiKey, chatModelName });
  }

  // ---- 内部 ----

  /**
   * 用户已配置 API Key 的供应商 id 列表（V0.3 系统选模型）：
   * 系统仅在用户提供过 Key 的供应商内自动选模型；全部未配置 → null（不限制，
   * 由 env 兜底 Key / 报错提示配置）。
   */
  private keyedProviders(s: ModelSettings): string[] | null {
    const withKey = Object.entries(s.providers)
      .filter(([, v]) => v && typeof v.apiKey === "string" && v.apiKey.trim() !== "")
      .map(([id]) => id);
    return withKey.length > 0 ? withKey : null;
  }

  /** 由解析结果（provider/model）+ 用户设置构造 ModelConfig（API Key / baseUrl 解析统一入口） */
  private buildModelConfig(
    resolved: { providerId: string; modelName: string },
    s: ModelSettings,
  ): ModelConfig {
    const provider = getProviderMeta(resolved.providerId);
    if (!provider) {
      throw new Error(`Unknown model provider: ${resolved.providerId}`);
    }
    const providerSettings = s.providers[resolved.providerId];
    // 环境变量兜底：用户未配置 Key 时使用 env 默认（本地/内网部署）
    const apiKey = providerSettings?.apiKey || this.envDefaults.apiKey;
    // 端点解析：用户配置了本供应商 Key → 直达供应商真实端点；否则 env 端点兜底（mock/网关）
    const baseUrl = resolveRuntimeBaseUrl(provider, {
      userApiKey: providerSettings?.apiKey,
      envBaseUrl: this.envDefaults.baseUrl,
    });
    return {
      // 所有供应商（火山/百炼）均为 OpenAI 兼容接口，统一使用该 provider
      providerId: "openai-compatible",
      baseUrl,
      apiKey,
      model: resolved.modelName,
    };
  }

  /**
   * 读取配置：优先用户行，退回历史全局行（user_id 为 NULL）。
   * 按 (key, user_id) 分别读取，避免旧全局配置被用户配置遮蔽。
   */
  private async loadRow(key: string, userId: string): Promise<unknown> {
    const rows = await this.db
      .select()
      .from(settingsTable)
      .where(and(eq(settingsTable.key, key), eq(settingsTable.userId, userId)))
      .limit(1);
    if (rows[0]) return JSON.parse(rows[0].value);
    const legacy = await this.db
      .select()
      .from(settingsTable)
      .where(and(eq(settingsTable.key, key), isNull(settingsTable.userId)))
      .limit(1);
    return legacy[0] ? JSON.parse(legacy[0].value) : null;
  }

  /** upsert 持久化（按 (key, user_id)） */
  private async save(key: string, userId: string, value: unknown): Promise<void> {
    const now = new Date();
    const existing = await this.db
      .select()
      .from(settingsTable)
      .where(and(eq(settingsTable.key, key), eq(settingsTable.userId, userId)))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(settingsTable)
        .set({ value: JSON.stringify(value), updatedAt: now })
        .where(and(eq(settingsTable.key, key), eq(settingsTable.userId, userId)));
    } else {
      await this.db.insert(settingsTable).values({
        key,
        userId,
        value: JSON.stringify(value),
        updatedAt: now,
      });
    }
  }
}
