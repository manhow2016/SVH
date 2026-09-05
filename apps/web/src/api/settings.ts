import { get, put } from "./client";
import type {
  ModelCatalog,
  ModelType,
  ModelTypeConfig,
  ProviderApiKey,
  PublicModelSettings,
} from "../types/api-types";

export interface ModelSettingsInput {
  providers?: Record<string, Partial<ProviderApiKey>>;
  models?: Partial<Record<ModelType, Partial<ModelTypeConfig>>>;
}

export const settingsApi = {
  /** 读取模型设置（供应商 API Key 掩码 + 类型模型选择）+ 目录元数据 */
  get: () => get<{ catalog: ModelCatalog; models: PublicModelSettings }>("/api/settings"),
  /** 更新模型设置（局部更新） */
  update: (input: ModelSettingsInput) =>
    put<{ models: PublicModelSettings }>("/api/settings", input),
};
