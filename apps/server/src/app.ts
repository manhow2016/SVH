import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createDatabase } from "@svh/database";
import { ContextBuilder, AgentRuntime } from "@svh/core";
import { ProviderRegistry, OpenAICompatibleProvider } from "@svh/providers";
import { WorkspaceManager } from "@svh/workspace";
import { ToolRegistry } from "@svh/tools";
import { listFilesTool } from "@svh/tools";
import { readFileTool } from "@svh/tools";
import { writeFileTool } from "@svh/tools";
import { deleteFileTool } from "@svh/tools";
import type { AppConfig } from "./config/index";
import { WorkspaceService } from "./modules/workspace/service";
import { SessionService } from "./modules/session/service";
import { SettingsService } from "./modules/settings/service";
import { AgentRunService } from "./modules/agent/run-service";
import { registerWorkspaceRoutes } from "./routes/workspace";
import { registerSessionRoutes } from "./routes/session";
import { registerAgentRoutes } from "./routes/agent";
import { registerFileRoutes } from "./routes/files";
import { registerSettingsRoutes } from "./routes/settings";
import { normalizeError } from "./lib/errors";

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * 应用组装（组合根）。
 *
 * 依赖方向严格遵循：shared ← database ← workspace/providers/tools ← core ← server。
 */
export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  // CORS：允许 Vite dev server
  const corsOrigins =
    config.corsOrigin === "*"
      ? true
      : config.corsOrigin
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean);
  await app.register(cors, { origin: corsOrigins });

  // ---- 基础设施 ----
  const db = createDatabase(config.databaseUrl);

  // ---- 领域服务 ----
  const workspaceManager = new WorkspaceManager({ db, workspaceRoot: config.workspaceRoot });
  // 补齐所有已有工作区的初始资产树（幂等）
  await workspaceManager.ensureDefaultAssets();
  const workspaceService = new WorkspaceService(workspaceManager);
  const sessionService = new SessionService(db);
  const settingsService = new SettingsService(db, config.llm);

  // ---- Provider Registry（Agent Runtime 通过 Registry 获取 Provider） ----
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(
    new OpenAICompatibleProvider({
      baseUrl: config.llm.baseUrl || "http://localhost:11434/v1",
      apiKey: config.llm.apiKey,
    }),
  );

  // ---- Tool Registry（内置 4 个工具） ----
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(listFilesTool);
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(deleteFileTool);

  // ---- Agent Runtime ----
  const contextBuilder = new ContextBuilder({ db, workspaceManager });
  const runtime = new AgentRuntime({
    providerRegistry,
    toolRegistry,
    contextBuilder,
    workspaceManager,
  });
  const runService = new AgentRunService({
    runtime,
    sessionService,
    workspaceService,
    settingsService,
    providerRegistry,
    log: app.log,
  });

  // ---- 路由 ----
  registerWorkspaceRoutes(app, { workspaceService, log: app.log });
  registerSessionRoutes(app, { sessionService, workspaceService, log: app.log });
  registerAgentRoutes(app, { runService });
  registerFileRoutes(app, { workspaceService });
  registerSettingsRoutes(app, { settingsService });

  // ---- 统一错误处理（文档 §47） ----
  app.setErrorHandler((err, _req, reply) => {
    const { status, code, message, details } = normalizeError(err);
    if (status >= 500) {
      app.log.error({ err, code }, `unhandled error: ${message}`);
    }
    const error = details === undefined ? { code, message } : { code, message, details };
    return reply.status(status).send({ error });
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.status(404).send({
      error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` },
    });
  });

  return app;
}
