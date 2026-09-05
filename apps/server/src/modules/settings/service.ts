import { and, eq, isNull } from "drizzle-orm";
import { settings as settingsTable, type SVHDatabase } from "@svh/database";
import type { ModelConfig } from "@svh/providers";
import type { LLMEnvConfig } from "../../config/index";
import {
  MODEL_PROVIDERS,
  MODEL_TYPES,
  getProviderMeta,
  resolveProviderBaseUrl,
  type ModelType,
  type ModelTypeConfig,
  type ProviderApiKey,
} from "./model-catalog";

/** 模型设置（服务端内部，含 API Key）：
 * - providers：按供应商存 API Key（内置供应商固定 endpoint；自定义可填 baseUrl）
 * - models：每个模型类型的当前选择（供应商 + 模型名）
 */
export interface ModelSettings {
  providers: Record<string, ProviderApiKey>;
  models: Record<ModelType, ModelTypeConfig>;
}

/** 暴露给前端的模型设置（ApiKey 不直出，仅 hasApiKey） */
export interface PublicModelSettings {
  providers: Array<{
    id: string;
    baseUrl?: string;
    hasApiKey: boolean;
  }>;
  models: Record<ModelType, ModelTypeConfig>;
}

/** 目录元数据（供应商 + 模型类型，前端展示用） */
export interface ModelCatalogView {
  providers: typeof MODEL_PROVIDERS;
  types: typeof MODEL_TYPES;
}

const SETTINGS_KEY = "model";

/**
 * Settings 服务（文档 §37 数据隔离：按用户存储）。
 *
 * 模型设置（V2）：供应商 API Key + 模型类型选择（文本/图片/视频/音频）。
 * 兼容旧数据：旧「llm」配置迁移为 custom 供应商 + text 模型（读取时转换）。
 * 查找顺序：用户配置 → 环境变量默认（作用于 custom 文本模型兜底）。
 */
export class SettingsService {
  constructor(
    private readonly db: SVHDatabase,
    private readonly envDefaults: LLMEnvConfig,
  ) {}

  /** 内置供应商目录 + 模型类型（静态） */
  catalog(): ModelCatalogView {
    return { providers: MODEL_PROVIDERS, types: MODEL_TYPES };
  }

  /** 获取生效的模型设置（用户配置优先，旧 llm 配置迁移，最后 env 兜底） */
  async getModelSettings(userId: string): Promise<ModelSettings> {
    const saved = (await this.loadRow(SETTINGS_KEY, userId)) as ModelSettings | null;

    // 旧「llm」配置 → custom 供应商 + text 模型（仅当尚未使用新格式保存时迁移）
    const migratedProviders: Record<string, ProviderApiKey> = {};
    let migratedText: ModelTypeConfig | null = null;
    if (!saved) {
      const legacy = (await this.loadRow("llm", userId)) as {
        baseUrl?: string;
        apiKey?: string;
        model?: string;
      } | null;
      if (legacy && (legacy.baseUrl || legacy.apiKey || legacy.model)) {
        migratedProviders.custom = {
          apiKey: legacy.apiKey ?? "",
          ...(legacy.baseUrl ? { baseUrl: legacy.baseUrl } : {}),
        };
        if (legacy.model) {
          migratedText = { provider: "custom", model: legacy.model };
        }
      }
    }

    const providers: Record<string, ProviderApiKey> = {
      ...migratedProviders,
      ...(saved?.providers ?? {}),
    };

    // 默认模型：未配置时 text 走 custom 环境变量；其余类型默认厂商推荐模型
    const defaults: Record<ModelType, ModelTypeConfig> = {
      text: {
        provider: migratedText?.provider ?? "custom",
        model:
          migratedText?.model ||
          (this.envDefaults.model !== "" ? this.envDefaults.model : "qwen-plus"),
      },
      image: { provider: "volcengine", model: "doubao-seedream-4-0-250828" },
      video: { provider: "volcengine", model: "doubao-seedance-1-0-pro-250528" },
      audio: { provider: "volcengine", model: "doubao-tts" },
    };

    const models: Record<ModelType, ModelTypeConfig> = {
      text: { ...defaults.text, ...(saved?.models?.text ?? {}) },
      image: { ...defaults.image, ...(saved?.models?.image ?? {}) },
      video: { ...defaults.video, ...(saved?.models?.video ?? {}) },
      audio: { ...defaults.audio, ...(saved?.models?.audio ?? {}) },
    };

    return { providers, models };
  }

  /** 更新模型设置并持久化（可按供应商 / 类型局部更新） */
  async updateModelSettings(
    userId: string,
    partial: {
      providers?: Record<string, Partial<ProviderApiKey>>;
      models?: Partial<Record<ModelType, Partial<ModelTypeConfig>>>;
    },
  ): Promise<ModelSettings> {
    const current = await this.getModelSettings(userId);

    const providers: Record<string, ProviderApiKey> = { ...current.providers };
    for (const [id, patch] of Object.entries(partial.providers ?? {})) {
      const base = providers[id] ?? { apiKey: "" };
      providers[id] = {
        apiKey: patch.apiKey !== undefined ? patch.apiKey : base.apiKey,
        // undefined 时保留原值；空字符串允许清空 baseUrl（不存在该场景则忽略）
        ...(patch.baseUrl !== undefined
          ? { baseUrl: patch.baseUrl }
          : base.baseUrl !== undefined
            ? { baseUrl: base.baseUrl }
            : {}),
      };
      // 固定端点供应商不允许保存自定义 baseUrl
      const meta = getProviderMeta(id);
      if (meta?.fixedEndpoint) {
        delete providers[id]!.baseUrl;
      }
    }

    const models: Record<ModelType, ModelTypeConfig> = { ...current.models };
    for (const [type, patch] of Object.entries(partial.models ?? {}) as Array<
      [ModelType, Partial<ModelTypeConfig>]
    >) {
      const base = models[type];
      const next: ModelTypeConfig = {
        provider: patch.provider !== undefined ? patch.provider : base.provider,
        model: patch.model !== undefined ? patch.model : base.model,
      };
      // 校验供应商存在
      if (!getProviderMeta(next.provider)) {
        continue;
      }
      models[type] = next;
    }

    const next: ModelSettings = { providers, models };
    await this.save(SETTINGS_KEY, userId, next);
    return next;
  }

  /** 前端可见视图（隐藏 ApiKey 明文，仅暴露目录元数据 + hasApiKey） */
  async getPublicModelSettings(userId: string): Promise<PublicModelSettings> {
    const s = await this.getModelSettings(userId);
    const providers = Object.entries(s.providers).map(([id, v]) => {
      const meta = getProviderMeta(id);
      // 固定端点供应商的 baseUrl 由目录提供，无需回传
      return meta?.fixedEndpoint
        ? { id, hasApiKey: v.apiKey !== "" }
        : { id, baseUrl: v.baseUrl, hasApiKey: v.apiKey !== "" };
    });
    return { providers, models: s.models };
  }

  /**
   * 由会话模型配置 + 用户生效设置构造 ModelConfig（文档 §11）。
   * 会话指定模型时优先使用；否则取对应类型的默认模型（V1 运行时仅使用 text 类型）。
   */
  async getEffectiveModelConfig(
    session: { modelId: string },
    userId: string,
    type: ModelType = "text",
  ): Promise<ModelConfig> {
    const s = await this.getModelSettings(userId);
    const typeConfig = s.models[type];
    const provider = getProviderMeta(typeConfig.provider);
    if (!provider) {
      throw new Error(`Unknown model provider: ${typeConfig.provider}`);
    }
    const providerSettings = s.providers[typeConfig.provider];
    // 环境变量兜底：custom 供应商且无用户配置时使用 env 默认
    const apiKey = providerSettings?.apiKey ?? this.envDefaults.apiKey;
    const baseUrl = resolveProviderBaseUrl(
      provider,
      providerSettings?.baseUrl ?? this.envDefaults.baseUrl,
    );
    const model = session.modelId.trim() !== "" ? session.modelId : typeConfig.model;
    return {
      // 所有供应商（火山/百炼/自定义）均为 OpenAI 兼容接口，统一使用该 provider
      providerId: "openai-compatible",
      baseUrl,
      apiKey,
      model,
    };
  }

  // ---- 内部 ----

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
