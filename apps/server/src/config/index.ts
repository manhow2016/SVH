import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

/** 仓库根目录（apps/server/src/config → SVH 根） */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export interface LLMEnvConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  workspaceRoot: string;
  corsOrigin: string;
  llm: LLMEnvConfig;
}

/** 加载 .env（优先仓库根目录）并解析全部配置 */
export function loadConfig(): AppConfig {
  loadDotEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
  loadDotEnv({ path: path.join(REPO_ROOT, ".env.local"), quiet: true });

  const port = parseInt(process.env.SVH_PORT ?? "3000", 10);
  const databaseUrl = resolveFromRoot(process.env.SVH_DATABASE_URL ?? "file:./data/svh.db");
  const workspaceRoot = resolveFromRoot(process.env.SVH_WORKSPACE_ROOT ?? "./data/workspaces");

  return {
    port: Number.isFinite(port) ? port : 3000,
    databaseUrl,
    workspaceRoot,
    corsOrigin: process.env.SVH_CORS_ORIGIN ?? "http://localhost:5173",
    llm: {
      baseUrl: process.env.SVH_LLM_BASE_URL ?? "",
      apiKey: process.env.SVH_LLM_API_KEY ?? "",
      model: process.env.SVH_LLM_MODEL ?? "",
    },
  };
}

/** 相对路径基于仓库根目录解析 */
function resolveFromRoot(p: string): string {
  if (p.startsWith("file:")) {
    const stripped = p.slice("file:".length);
    return path.isAbsolute(stripped) ? stripped : path.resolve(REPO_ROOT, stripped);
  }
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}
