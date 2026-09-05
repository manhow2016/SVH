import { get, put } from "./client";
import type { SettingsView } from "../types/api-types";

/** 供应商 API Key 更新（留空字段不修改；仅提交有变化的供应商） */
export interface ModelSettingsInput {
  providers?: Record<string, { apiKey?: string }>;
}

export const settingsApi = {
  /** 读取模型设置视图（供应商 API Key 掩码 + 各供应商可用模型列表） */
  get: () => get<SettingsView>("/api/settings"),
  /** 更新供应商 API Key（局部更新） */
  update: (input: ModelSettingsInput) => put<SettingsView>("/api/settings", input),
};
