import { eq } from "drizzle-orm";
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
 * Settings 服务。
 *
 * V1：环境变量为默认值，Settings 页面修改项持久化到 settings 表（服务端存储）。
 */
export class SettingsService {
  constructor(
    private readonly db: SVHDatabase,
    private readonly envDefaults: LLMEnvConfig,
  ) {}

  /** 获取生效的 LLM 设置（env 优先到默认，settings 表可覆盖） */
  async getLLM(): Promise<LLMSettings> {
    const rows = await this.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, LLM_KEY))
      .limit(1);
    const saved = rows[0] ? (JSON.parse(rows[0].value) as Partial<LLMSettings>) : {};
    return {
      baseUrl: saved.baseUrl ?? this.envDefaults.baseUrl,
      apiKey: saved.apiKey ?? this.envDefaults.apiKey,
      model: saved.model ?? this.envDefaults.model,
    };
  }

  /** 更新 LLM 设置并持久化 */
  async updateLLM(partial: Partial<LLMSettings>): Promise<LLMSettings> {
    const current = await this.getLLM();
    const next: LLMSettings = {
      baseUrl: partial.baseUrl !== undefined ? partial.baseUrl : current.baseUrl,
      apiKey: partial.apiKey !== undefined ? partial.apiKey : current.apiKey,
      model: partial.model !== undefined ? partial.model : current.model,
    };
    const now = new Date();
    const existing = await this.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, LLM_KEY))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(settingsTable)
        .set({ value: JSON.stringify(next), updatedAt: now })
        .where(eq(settingsTable.key, LLM_KEY));
    } else {
      await this.db.insert(settingsTable).values({
        key: LLM_KEY,
        value: JSON.stringify(next),
        updatedAt: now,
      });
    }
    return next;
  }

  /** 前端可见视图（隐藏 ApiKey） */
  async getPublicLLM(): Promise<PublicLLMSettings> {
    const s = await this.getLLM();
    return { baseUrl: s.baseUrl, model: s.model, hasApiKey: s.apiKey !== "" };
  }

  /** 由会话模型配置 + 生效设置构造 ModelConfig */
  async getEffectiveModelConfig(session: { modelId: string }): Promise<ModelConfig> {
    const s = await this.getLLM();
    return {
      providerId: "openai-compatible",
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: session.modelId.trim() !== "" ? session.modelId : s.model,
    };
  }
}
