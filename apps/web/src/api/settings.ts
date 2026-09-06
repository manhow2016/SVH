import { get, post, put } from "./client";
import type { ProviderVerifyResult, SettingsView } from "../types/api-types";

/** 模型设置更新（局部更新：供应商 API Key / 用户启用的模型 id 列表） */
export interface ModelSettingsInput {
  providers?: Record<string, { apiKey?: string }>;
  enabledModels?: string[] | null;
}

export const settingsApi = {
  /** 读取模型设置视图（供应商 API Key 掩码 + 各供应商可用模型列表 + 用户启用列表） */
  get: () => get<SettingsView>("/api/settings"),
  /** 更新模型设置（局部更新） */
  update: (input: ModelSettingsInput) => put<SettingsView>("/api/settings", input),
  /**
   * 验证供应商 API Key（不落库）。
   * @param apiKey 待测 Key（传入则验证草稿值；缺省验证用户已保存的 Key）
   */
  verify: (providerId: string, apiKey?: string) =>
    post<ProviderVerifyResult>("/api/settings/verify", {
      providerId,
      ...(apiKey ? { apiKey } : {}),
    }),
};
