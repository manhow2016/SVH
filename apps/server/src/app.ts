import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createDatabase } from "@svh/database";
import { ContextBuilder, AgentRuntime } from "@svh/core";
import { ProviderRegistry, OpenAICompatibleProvider } from "@svh/providers";
import { AssetsManager, WorkspaceManager } from "@svh/workspace";
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
import { UserService } from "./modules/user/service";
import { AuthService } from "./modules/auth/service";
import { createAuthenticate, requireAdmin } from "./modules/auth/middleware";
import { registerWorkspaceRoutes } from "./routes/workspace";
import { registerSessionRoutes } from "./routes/session";
import { registerAgentRoutes } from "./routes/agent";
import { registerFileRoutes } from "./routes/files";
import { registerAssetsRoutes } from "./routes/assets";
import { registerSettingsRoutes } from "./routes/settings";
import { registerAuthRoutes } from "./routes/auth";
import { registerAdminRoutes } from "./routes/admin";
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
  // 全局资产库（跨工作区共享；启动时初始化「默认」资产文件夹含四个资源类型）
  const assetsManager = new AssetsManager({ assetsRoot: config.assetsRoot });
  await assetsManager.ensureDefault();
  const sessionService = new SessionService(db);
  const settingsService = new SettingsService(db, config.llm);

  // ---- 认证 / 用户（文档 §22-§24） ----
  const userService = new UserService(db);
  const authService = new AuthService(db, userService, config.jwtSecret);
  const authenticate = createAuthenticate(authService);
  const requireAdminGuard = requireAdmin();

  // 管理员引导账号 + 历史工作区归属（会员系统引入后，单用户数据归属管理员）
  const bootstrap = await authService.ensureBootstrapAdmin(
    config.admin.username,
    config.admin.password,
    config.admin.email,
  );
  if (bootstrap.created) {
    app.log.warn(
      { username: bootstrap.user.username },
      `已创建管理员引导账号（默认密码：${config.admin.password}），请尽快修改密码`,
    );
  }
  const claimed = await workspaceService.claimLegacy(bootstrap.user.id);
  if (claimed > 0) {
    app.log.info({ count: claimed, owner: bootstrap.user.username }, "历史工作区已归属管理员");
  }

  // ---- 全局认证（文档 §23/§33）：所有 /api 除 注册/登录 外均需 JWT ----
  const PUBLIC_AUTH_PATHS = ["/api/auth/register", "/api/auth/login"];
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    if (PUBLIC_AUTH_PATHS.some((p) => request.url.startsWith(p))) return;
    await authenticate(request);
  });

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
  registerAuthRoutes(app, { authService, userService });
  registerWorkspaceRoutes(app, { workspaceService, log: app.log });
  registerSessionRoutes(app, { sessionService, workspaceService, log: app.log });
  registerAgentRoutes(app, { runService });
  registerFileRoutes(app, { workspaceService });
  registerAssetsRoutes(app, { assetsManager });
  registerSettingsRoutes(app, { settingsService });
  registerAdminRoutes(app, {
    userService,
    authenticate,
    requireAdminGuard,
  });

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
