import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { spawn } from "node:child_process";
import { stat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "@svh/database";
import { ContextBuilder, AgentRuntime } from "@svh/core";
import { ProviderRegistry, OpenAICompatibleProvider } from "@svh/providers";
import { AssetsManager, WorkspaceManager, resolveSafeWorkspacePath } from "@svh/workspace";
import { ToolRegistry } from "@svh/tools";
import { listFilesTool } from "@svh/tools";
import { readFileTool } from "@svh/tools";
import { writeFileTool } from "@svh/tools";
import { deleteFileTool } from "@svh/tools";
import {
  addTimelineClipTool,
  addTimelineTrackTool,
  autoCreateTimelineTool,
  createEpisodeTool,
  createProjectTool,
  createScriptTool,
  createShotTool,
  createCharacterTool,
  listEpisodesTool,
  createSceneTool,
  createStoryboardTool,
  createTimelineTool,
  deleteTimelineClipTool,
  getProjectTool,
  getScriptTool,
  getTimelineTool,
  listProjectsTool,
  listScriptsTool,
  listCharactersTool,
  updateProjectTool,
  updateScriptTool,
  updateShotTool,
  updateCharacterTool,
  updateStoryboardTool,
  updateTimelineClipTool,
} from "@svh/tools";
import {
  DefaultPromptComposer,
  DrizzleProductionRepository,
  LOCALIZE_DIR_PREFIX,
  LOCALIZE_METADATA_KEY,
  ProductionContextResolver,
  ProductionService,
  TimelineService,
  readLocalizeConfig,
  renderProductionContext,
  type LocalizeMetadata,
} from "@svh/production";
import type { AppConfig } from "./config/index";
import { WorkspaceService } from "./modules/workspace/service";
import { SessionService } from "./modules/session/service";
import { SettingsService } from "./modules/settings/service";
import { ModelService } from "./modules/settings/model-service";
import { AgentRunService } from "./modules/agent/run-service";
import { AutoPipelineService } from "./modules/agent/auto-pipeline";
import { getProfileById } from "./modules/agent/profiles";
import { WorkflowService } from "./modules/production/workflow-service";
import { GenerationService } from "./modules/production/generation-service";
import { RenderTaskService } from "./modules/production/render-task-service";
import { createRealGenerationDeps, runGenerationNode } from "./modules/production/generation-node-executor";
import { createRealReviewDeps, runReviewNode } from "./modules/production/review-node";
import { runAudioNode, type AudioNodeDeps } from "./modules/production/audio-node";
import { runSubtitleNode, type SubtitleNodeDeps } from "./modules/production/subtitle-node";
import { runComposeNode, type ComposeNodeDeps } from "./modules/production/compose-node";
import { SkillRunService } from "./modules/skills/skill-run-service";
import { UserService } from "./modules/user/service";
import { AuthService } from "./modules/auth/service";
import { createAuthenticate, requireAdmin } from "./modules/auth/middleware";
import { registerSessionRoutes } from "./routes/session";
import { registerAgentRoutes } from "./routes/agent";
import { registerSkillsRoutes } from "./routes/skills";
import { registerAssetsRoutes } from "./routes/assets";
import { registerSettingsRoutes } from "./routes/settings";
import { registerProductionRoutes } from "./routes/production";
import { registerGenerationReviewRoutes } from "./routes/generation-review";
import { registerMediaRoutes } from "./routes/media";
import { registerAuthRoutes } from "./routes/auth";
import { registerAdminRoutes } from "./routes/admin";
import { registerMembershipRoutes } from "./routes/membership";
import { FeatureService } from "./modules/membership/feature-service";
import { MembershipService } from "./modules/membership/service";
import {
  SubscriptionPlanService,
  SubscriptionService,
} from "./modules/membership/subscription-service";
import { PromotionService } from "./modules/membership/promotion-service";
import { normalizeError } from "./lib/errors";

export interface BuildAppOptions {
  logger?: boolean;
  /**
   * 手动转存下载注入面（测试专用假实现）：fetchImpl 假网络、sleep 假退避（记录毫秒不等待）。
   * 生产缺省不传 → localizeToFile 走 globalThis.fetch + 真实退避（500/2000/8000ms）。
   */
  localize?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };
}

/** 鉴权前缀判定用的段解码：相对 find-my-way 的判定为方向性宁严（等价或更严，永不少拦）；
 * 非法转义保留原文（双方都当字面量），差异只可能多拦一道验签、不可能反向放行。 */
function safeDecodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * 鉴权钩子用的规范路径：先经 URL 解析去掉 query（编码前缀判定的顺带收益：
 * 查询串不再能干扰前缀观察），并把绝对形式请求行归一到 path；
 * 再逐段 safe-decode。判定方向性宁严（等价或更严，永不少拦）：路由能匹配到
 * /api 处理器时此处必见 /api 前缀；反向差异（如段内 %2F）只多拦一道验签，不产生放行面。
 */
function hookPathname(rawUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    pathname = rawUrl.split("?", 1)[0] ?? "/"; // 畸形请求行：退原始串去 query，保守判
  }
  return pathname.split("/").map(safeDecodeSegment).join("/");
}

/**
 * 应用组装（组合根）。
 *
 * 依赖方向严格遵循：shared ← database ← workspace/providers/tools ← core ← server。
 */

/** 解析 ffmpeg 可执行路径：SVH_FFMPEG_PATH 优先，其次 @ffmpeg-installer 本地静态二进制 */
function resolveFfmpegPath(): string {
  const envPath = process.env.SVH_FFMPEG_PATH;
  if (envPath) return envPath;
  try {
    return (createRequire(import.meta.url)("@ffmpeg-installer/ffmpeg") as { path: string }).path;
  } catch {
    throw new Error("未找到 ffmpeg：请 apt install ffmpeg（或设置 SVH_FFMPEG_PATH）后重试成片组装");
  }
}

/** 字幕滤镜（libass）能力缓存：-filters 首次探测一次 */
let ffmpegSubtitlesSupport: boolean | undefined;

/** 探测 ffmpeg 是否支持 subtitles 滤镜（烧录 SRT 用） */
async function probeFfmpegSubtitles(): Promise<boolean> {
  if (ffmpegSubtitlesSupport !== undefined) return ffmpegSubtitlesSupport;
  const ffmpegPath = resolveFfmpegPath();
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-filters"], {});
    let buf = "";
    child.stdout.on("data", (d: Buffer) => (buf += d.toString()));
    child.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    child.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error("ffmpeg -filters 失败"))));
    child.on("error", reject);
  });
  ffmpegSubtitlesSupport = /\bsubtitles\b/.test(out);
  return ffmpegSubtitlesSupport;
}

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
  const modelService = new ModelService(db);
  const settingsService = new SettingsService(db, config.llm, modelService);

  // ---- 会员系统（文档 §17/§25；与模型 Provider 完全解耦，原则 6） ----
  const featureService = new FeatureService(db);
  // 认证 / 用户（文档 §22-§24）：userService 先创建（会员服务需判定管理员角色）
  const userService = new UserService(db);
  const membershipService = new MembershipService(db, userService);
  // 活动服务兼作价格计算器（§14：getBestPromotion + calculatePrice，整数金额）
  const promotionService = new PromotionService(db);
  const planService = new SubscriptionPlanService(db, promotionService);
  const subscriptionService = new SubscriptionService(db, planService, promotionService);

  // ---- 认证 ----
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
  // 前提钉：所有受保护路由必须挂在 /api/ 前缀下——钩子按该前缀豁免，任何绕开
  // /api/ 注册的新路由组 = 不鉴权裸面（注册 review 清单项）。
  // 安全钉（评审安全轮）：find-my-way 按「逐段百分号解码后」的路径匹配路由，
  // 判定若用原始串会被编码前缀绕过（实测 /%61pi/workspaces 跳过 authenticate
  // 直达受保护处理器）。故前缀判定走 hookPathname()：去 query、绝对形式规范化、
  // 再逐段 safe-decode——对 find-my-way 的判定方向性宁严（等价或更严，永不少拦）：
  // 保守误差只会「多拦不少拦」（如 %2F、dot 段：本层判 /api 而路由 404 → 宁严 401），
  // 不存在反向绕过面。
  // /api/media 豁免：`<img>/<video>` 带不了 Authorization，token 走 query 由路由内
  // AuthService.verifyToken 自验（同 Bearer 验签路径，spec §5；不改 Bearer 行为）。
  // /api/assets/raw 同理：资产库文件送达（「我的资产」引用进项目后的预览地址）。
  const PUBLIC_AUTH_PATHS = ["/api/auth/register", "/api/auth/login"];
  app.addHook("onRequest", async (request) => {
    const path = hookPathname(request.url);
    if (!path.startsWith("/api/")) return;
    if (path.startsWith("/api/media/")) return;
    if (path.startsWith("/api/assets/raw")) return;
    if (PUBLIC_AUTH_PATHS.some((p) => path.startsWith(p))) return;
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

  // ---- Tool Registry（内置 4 个工具 + 生产领域 16 个工具） ----
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(listFilesTool);
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(deleteFileTool);

  // 生产领域服务与工具（文档 §10：Agent 通过工具操作 Production Domain）
  const production = new ProductionService(new DrizzleProductionRepository(db));
  // V0.3 Phase 3/6：成片时间轴服务（下沉 @svh/production，路由与工具共用）
  const timelineService = new TimelineService(new DrizzleProductionRepository(db));
  // V0.3 Phase 1：生产上下文解析器（按项目 + Agent 角色加载最小相关投影，注入 System Prompt）
  const productionContextResolver = new ProductionContextResolver(production);
  toolRegistry.register(createProjectTool({ production }));
  toolRegistry.register(getProjectTool({ production }));
  toolRegistry.register(updateProjectTool({ production }));
  toolRegistry.register(listProjectsTool({ production }));
  // 短剧多集（V0.3）
  toolRegistry.register(createEpisodeTool({ production }));
  toolRegistry.register(listEpisodesTool({ production }));
  toolRegistry.register(createScriptTool({ production }));
  toolRegistry.register(getScriptTool({ production }));
  toolRegistry.register(updateScriptTool({ production }));
  toolRegistry.register(listScriptsTool({ production }));
  toolRegistry.register(createCharacterTool({ production }));
  toolRegistry.register(updateCharacterTool({ production }));
  toolRegistry.register(listCharactersTool({ production }));
  toolRegistry.register(createSceneTool({ production }));
  toolRegistry.register(createStoryboardTool({ production }));
  toolRegistry.register(updateStoryboardTool({ production }));
  toolRegistry.register(createShotTool({ production }));
  toolRegistry.register(updateShotTool({ production }));
  // Timeline 工具（V0.3 文档 Phase 6）
  toolRegistry.register(createTimelineTool({ production, timeline: timelineService }));
  toolRegistry.register(getTimelineTool({ production, timeline: timelineService }));
  toolRegistry.register(autoCreateTimelineTool({ production, timeline: timelineService }));
  toolRegistry.register(addTimelineTrackTool({ production, timeline: timelineService }));
  toolRegistry.register(addTimelineClipTool({ production, timeline: timelineService }));
  toolRegistry.register(updateTimelineClipTool({ production, timeline: timelineService }));
  toolRegistry.register(deleteTimelineClipTool({ production, timeline: timelineService }));

  // ---- Agent Runtime ----
  const contextBuilder = new ContextBuilder({ db, workspaceManager });
  const runtime = new AgentRuntime({
    providerRegistry,
    toolRegistry,
    contextBuilder,
    workspaceManager,
  });
  const skillRunService = new SkillRunService({
    sessionService,
    workspaceService,
    settingsService,
    membershipService,
    providerRegistry,
    log: app.log,
  });

  // ---- Workflow Engine（文档 §11：节点执行器 = 带 Agent Profile 的 Agent Run） ----
  // 节点类型 → 专业角色映射（文档 §12 生产 DAG）
  const PROFILE_BY_NODE_TYPE: Record<string, string> = {
    "script.generate": "script",
    "character.extract": "script",
    "scene.generate": "storyboard",
    "storyboard.generate": "storyboard",
  };
  const workflowService = new WorkflowService({
    db,
    log: app.log,
    executorFactory: (ctx) => ({
      async execute(node, input, signal) {
        // 工作流生成节点：批量扇出分镜 → 队列 → 等待终态 → 绑定资产（并行代理交付，这里接线）
        if (node.type === "image.generate" || node.type === "video.generate") {
          return runGenerationNode({
            ctx: { projectId: ctx.projectId, workflowId: ctx.workflowId, userId: ctx.userId },
            node,
            input,
            deps: createRealGenerationDeps({
              db,
              production,
              generationService,
              pollMs: config.workflowGen?.pollMs ?? 500,
              maxWaitMs: config.workflowGen?.maxWaitMs ?? 900_000,
            }),
            signal,
          });
        }
        // 工作流人类审核节点：人工裁定生成结果（waiting_user 挂起 → 审核后恢复续跑）
        if (node.type === "review.generation") {
          return runReviewNode({
            ctx: { projectId: ctx.projectId, workflowId: ctx.workflowId, userId: ctx.userId },
            node,
            input,
            deps: createRealReviewDeps({ db }),
          });
        }
        // 配音节点：带对白镜头批量 TTS（音色取场景首角色 voice）
        if (node.type === "audio.generate") {
          const deps: AudioNodeDeps = {
            pollMs: config.workflowGen?.pollMs ?? 500,
            maxWaitMs: config.workflowGen?.maxWaitMs ?? 900_000,
            listStoryboards: (pid) => production.listStoryboards(pid),
            listShotsByStoryboard: (sid) => production.listShotsByStoryboard(sid),
            resolveSceneVoice: async (sceneId) => {
              const scene = await production.getScene(sceneId);
              const first = scene.characters[0];
              if (!first) return undefined;
              try {
                return (await production.getCharacter(first)).voice;
              } catch {
                return undefined;
              }
            },
            enqueueAudio: (i) => generationService.enqueueAudio(i),
            getTask: (id) => Promise.resolve(generationService.getTask(id)),
            findAssetByTask: (taskId) => production.findAssetByTask(taskId),
            updateShotAudio: async (shotId, assetId) => {
              await production.updateShot(shotId, { audioAssetId: assetId });
            },
            listTasksByNode: (wf, nodeId) => generationService.listTasksByNode(wf, nodeId),
          };
          return runAudioNode({ ctx, node, input, deps, signal });
        }
        // 字幕节点：本地生成分镜切片 SRT（无模型依赖），落 subtitle 资产
        if (node.type === "subtitle.generate") {
          const deps: SubtitleNodeDeps = {
            listStoryboards: (pid) => production.listStoryboards(pid),
            listShotsByStoryboard: (sid) => production.listShotsByStoryboard(sid),
            createSubtitleAsset: async ({ projectId: pid, name, srt }) =>
              production.createAsset({ projectId: pid, type: "subtitle", name, metadata: { srt } }),
          };
          return runSubtitleNode({ ctx, node, input, deps });
        }
        // 成片组装节点：画面段 concat 成片（ffmpeg；配音/字幕作为独立资产交付）
        if (node.type === "video.compose") {
          const deps: ComposeNodeDeps = {
            listStoryboards: (pid) => production.listStoryboards(pid),
            listShotsByStoryboard: (sid) => production.listShotsByStoryboard(sid),
            localAssetPath: async (assetId) => {
              try {
                const asset = await production.getAsset(assetId);
                if (!asset.workspacePath) return null;
                const abs = await resolveSafeWorkspacePath(
                  path.join(config.workspaceRoot, asset.workspaceId),
                  asset.workspacePath,
                );
                const st = await stat(abs);
                return st.isFile() ? abs : null;
              } catch {
                return null;
              }
            },
            createComposedAsset: async ({ projectId: pid, name }) =>
              production.createAsset({
                projectId: pid,
                type: "video",
                name,
                generation: { providerId: "compose", prompt: "成片组装" },
              }),
            prepareOutput: async (assetId) => {
              const asset = await production.getAsset(assetId);
              const workspacePath = `${LOCALIZE_DIR_PREFIX}${assetId}.mp4`;
              const abs = path.join(config.workspaceRoot, asset.workspaceId, workspacePath);
              await mkdir(path.dirname(abs), { recursive: true });
              return { abs, workspacePath };
            },
            markOutputReady: async (assetId, workspacePath, bytes) => {
              const asset = await production.getAsset(assetId);
              await production.updateAssetFields(assetId, {
                workspacePath,
                mimeType: "video/mp4",
                metadata: {
                  ...(asset.metadata ?? {}),
                  [LOCALIZE_METADATA_KEY]: {
                    state: "ready",
                    bytes,
                    at: new Date().toISOString(),
                  } satisfies LocalizeMetadata,
                },
              });
            },
            runFfmpeg: async (args, cwd) => {
              const ffmpegPath = resolveFfmpegPath();
              await new Promise<void>((resolve, reject) => {
                const child = spawn(ffmpegPath, args, { cwd });
                let stderr = "";
                child.stderr.on("data", (d: Buffer) => {
                  stderr += d.toString();
                });
                child.on("close", (code) => {
                  if (code === 0) resolve();
                  else reject(new Error(`ffmpeg 失败（exit ${code}）：${stderr.slice(-500)}`));
                });
                child.on("error", reject);
              });
            },
            createTempDir: async () => mkdtemp(path.join(os.tmpdir(), "svh-compose-")),
            removeDir: async (dir) => rm(dir, { recursive: true, force: true }),
            hasSubtitles: probeFfmpegSubtitles,
          };
          return runComposeNode({ ctx, node, input, deps });
        }

        const profileId = PROFILE_BY_NODE_TYPE[node.type] ?? "director";
        const profile = getProfileById(profileId);
        if (!profile) {
          throw new Error(`工作流节点类型 ${node.type} 无对应 Agent 角色`);
        }
        // V0.3 Phase 1：组装生产上下文（按项目 + 角色加载最小相关投影，注入 System Prompt）。
        // 失败不阻断 Agent 执行——降级为「无生产上下文」，避免上下文问题拖垮整个工作流。
        let productionContext: string | undefined;
        if (ctx.projectId) {
          try {
            const resolved = await productionContextResolver.resolve({
              projectId: ctx.projectId,
              role: profile.id as "director" | "script" | "storyboard",
            });
            productionContext = renderProductionContext(resolved) || undefined;
          } catch (err) {
            app.log.warn(
              { projectId: ctx.projectId, role: profile.id, error: (err as Error).message },
              "生产上下文解析失败，跳过注入（不影响工作流执行）",
            );
          }
        }
        const raw = (input ?? {}) as { prompt?: unknown };
        const prompt =
          typeof raw.prompt === "string" && raw.prompt.trim() !== ""
            ? raw.prompt
            : `请执行工作流节点：${node.name}（${node.type}）`;
        let text = "";
        const toolOutputs: Array<{ tool: string; output: unknown }> = [];
        for await (const event of runtime.run(
          {
            sessionId: ctx.sessionId,
            workspaceId: ctx.workspaceId,
            userMessage: prompt,
            modelConfig: ctx.modelConfig,
            profile,
            productionContext,
          },
          signal,
        )) {
          if (event.type === "message.delta") {
            text += event.content;
          } else if (event.type === "tool.completed") {
            toolOutputs.push({ tool: event.toolName, output: event.output });
          } else if (event.type === "run.error") {
            throw new Error(`Agent 执行失败：${event.error}`);
          }
        }
        return { text, toolOutputs };
      },
    }),
  });

  // ---- Chat → Workflow 自动串联（Director 建项目后自动启动生产工作流） ----
  const autoPipeline = new AutoPipelineService({
    workflowService,
    membershipService,
    log: app.log,
  });
  const runService = new AgentRunService({
    runtime,
    sessionService,
    workspaceService,
    settingsService,
    membershipService,
    providerRegistry,
    autoPipeline,
    log: app.log,
  });

  // ---- 路由 ----
  registerAuthRoutes(app, { authService, userService, workspaceService });
  registerMembershipRoutes(app, { membershipService, planService });
  registerSessionRoutes(app, { sessionService, workspaceService, productionService: production, log: app.log });
  const generationService = new GenerationService({
    db,
    settings: settingsService,
    production,
    promptComposer: new DefaultPromptComposer(),
  });
  registerAgentRoutes(app, { runService });
  registerSkillsRoutes(app, { skillRunService });
  registerAssetsRoutes(app, {
    assetsManager,
    membershipService,
    generationService,
    assetsRoot: config.assetsRoot,
    production,
    authService,
    workspaceService,
  });
  registerSettingsRoutes(app, { settingsService });
  registerProductionRoutes(app, {
    workflowService,
    production,
    generationService,
    timeline: timelineService,
    // V0.3 Phase 7：时间轴渲染任务（校验 + 状态机 + queued 入队；执行在 worker Phase 8）
    renderTask: new RenderTaskService({ db, repo: new DrizzleProductionRepository(db) }),
    workspaceService,
    sessionService,
    settingsService,
    membershipService,
    // ---- 手动转存（spec §6）：路径组装 + 上限/超时 + 测试注入面 ----
    workspaceRoot: config.workspaceRoot,
    localizeConfig: readLocalizeConfig(process.env),
    fetchImpl: options.localize?.fetchImpl,
    sleep: options.localize?.sleep,
  });
  // ---- 生成审核 / 版本（V0.3 Phase 5）：独立路由，与扇出/绑定互补 ----
  registerGenerationReviewRoutes(app, {
    production,
    generationService,
    workflowService,
    workspaceService,
  });
  // ---- media 流式送达（资产本地化 spec §5）：token 走 query，路由内自验 ----
  registerMediaRoutes(app, {
    production,
    authService,
    workspaceService,
    workspaceRoot: config.workspaceRoot,
  });
  registerAdminRoutes(app, {
    userService,
    featureService,
    planService,
    subscriptionService,
    promotionService,
    modelService,
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
