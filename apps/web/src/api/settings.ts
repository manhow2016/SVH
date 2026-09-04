import { get, put } from "./client";
import type { PublicLLMSettings } from "../types/api-types";

export interface LLMSettingsInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export const settingsApi = {
  get: () => get<{ llm: PublicLLMSettings }>("/api/settings"),
  update: (llm: LLMSettingsInput) => put<{ llm: PublicLLMSettings }>("/api/settings", { llm }),
};
