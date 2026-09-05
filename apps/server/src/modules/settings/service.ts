import { and, eq, isNull } from "drizzle-orm";
import { settings as settingsTable, type SVHDatabase } from "@svh/database";
import type { ModelConfig } from "@svh/providers";
import type { LLMEnvConfig } from "../../config/index";

/** LLM 设置（服务端内部，含 API Key） */
export interface LLMSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 暴露给前端的 LLM 设置（ApiKey 不直出，文档 §45） */
export interface PublicLLMSettings {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

const LLM_KEY = "llm";

/**
 * Settings 服务（文档 §37 数据隔离：按用户存储）。
 *
 * 查找顺序：用户配置 → 历史全局配置（user_id 为 NULL）→ 环境变量默认。
 */
export class SettingsService {
  constructor(
    private readonly db: SVHDatabase,
    private readonly envDefaults: LLMEnvConfig,
  ) {}

  /** 获取生效的 LLM 设置（用户配置优先，其次历史全局，最后 env 默认） */
  async getLLM(userId: string): Promise<LLMSettings> {
    const saved = (await this.loadRow(LLM_KEY, userId)) as Partial<LLMSettings> | null;
    return {
      baseUrl: saved?.baseUrl ?? this.envDefaults.baseUrl,
      apiKey: saved?.apiKey ?? this.envDefaults.apiKey,
      model: saved?.model ?? this.envDefaults.model,
    };
  }

  /** 更新用户 LLM 设置并持久化（按 (key, user_id) upsert） */
  async updateLLM(userId: string, partial: Partial<LLMSettings>): Promise<LLMSettings> {
    const current = await this.getLLM(userId);
    const next: LLMSettings = {
      baseUrl: partial.baseUrl !== undefined ? partial.baseUrl : current.baseUrl,
      apiKey: partial.apiKey !== undefined ? partial.apiKey : current.apiKey,
      model: partial.model !== undefined ? partial.model : current.model,
    };
    const now = new Date();
    const existing = await this.db
      .select()
      .from(settingsTable)
      .where(and(eq(settingsTable.key, LLM_KEY), eq(settingsTable.userId, userId)))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(settingsTable)
        .set({ value: JSON.stringify(next), updatedAt: now })
        .where(and(eq(settingsTable.key, LLM_KEY), eq(settingsTable.userId, userId)));
    } else {
      await this.db.insert(settingsTable).values({
        key: LLM_KEY,
        userId,
        value: JSON.stringify(next),
        updatedAt: now,
      });
    }
    return next;
  }

  /** 前端可见视图（隐藏 ApiKey） */
  async getPublicLLM(userId: string): Promise<PublicLLMSettings> {
    const s = await this.getLLM(userId);
    return { baseUrl: s.baseUrl, model: s.model, hasApiKey: s.apiKey !== "" };
  }

  /** 由会话模型配置 + 用户生效设置构造 ModelConfig */
  async getEffectiveModelConfig(
    session: { modelId: string },
    userId: string,
  ): Promise<ModelConfig> {
    const s = await this.getLLM(userId);
    return {
      providerId: "openai-compatible",
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: session.modelId.trim() !== "" ? session.modelId : s.model,
    };
  }

  /** 读取配置：优先用户行，退回历史全局行（user_id 为 NULL） */
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
}
