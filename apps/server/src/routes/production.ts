/**
 * Production 生产领域 API（V0.2 文档 §15 / §20）。
 *
 * 覆盖生产项目的工作流管理：
 * - 项目工作流：创建 / 列表 / 详情
 * - 执行控制：run / pause / resume / cancel / retry（沿用 workflow.automation 会员门控）
 * - 事件订阅：GET /api/workflows/:id/events（SSE）
 *
 * 全部路由先做归属校验（项目/工作流 → workspace → user），
 * 任何越权访问一律 404（隐藏存在性）。
 */
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { stat, unlink } from "node:fs/promises";
import { isTerminalWorkflowEvent } from "@svh/core";
import {
  LOCALIZE_DIR_PREFIX,
  LOCALIZE_METADATA_KEY,
  extFromContentType,
  localizeToFile,
  type AssetFieldsPatch,
  type LocalizeMetadata,
  type ProductionAsset,
  type ProductionService,
} from "@svh/production";
import { resolveSafeWorkspacePath } from "@svh/workspace";
import type { WorkflowService } from "../modules/production/workflow-service";
import type { TimelineService } from "@svh/production";
import type { RenderTaskService } from "../modules/production/render-task-service";
import type { WorkspaceService } from "../modules/workspace/service";
import type { SessionService } from "../modules/session/service";
import type { SettingsService } from "../modules/settings/service";
import type { MembershipService } from "../modules/membership/service";
import type { GenerationService } from "../modules/production/generation-service";
import { requireFeature } from "../modules/auth/middleware";
import { writeSSEPayload } from "../lib/sse";
import { ERRORS, ServerError } from "../lib/errors";

export interface ProductionRouteDeps {
  workflowService: WorkflowService;
  production: ProductionService;
  generationService: GenerationService;
  /** V0.3 Phase 2：成片时间轴服务 */
  timeline: TimelineService;
  /** V0.3 Phase 7：时间轴渲染任务（ready → rendering + queued 入队） */
  renderTask: RenderTaskService;
  workspaceService: WorkspaceService;
  sessionService: SessionService;
  settingsService: SettingsService;
  membershipService: MembershipService;
  /** 工作区根（手动转存/删除清理的绝对路径组装，与 media 路由同款注入） */
  workspaceRoot: string;
  /** 转存单文件上限与单次尝试超时（app.ts readLocalizeConfig(process.env) 注入） */
  localizeConfig: { maxBytes: number; timeoutMs: number };
  /** 转存下载网络注入面（测试假 fetch；生产缺省 globalThis.fetch，与 worker HandlerDeps 同纪律） */
  fetchImpl?: typeof fetch;
  /** 转存退避注入面（测试 0ms 记录序列；生产缺省真实退避 500/2000/8000ms） */
  sleep?: (ms: number) => Promise<void>;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** localize 归属/存在性统一 404：文案与 media 路由逐字同构，封堵存在性 oracle（Task 3 三态纪律） */
const ASSET_NOT_ACCESSIBLE = () => new ServerError("NOT_FOUND", "资产不存在或不可访问", 404);

/** kind → 落盘扩展名兜底（与 worker KIND_MEDIA 同源；仅生成媒体三类有兜底命名权） */
const KIND_FALLBACK_EXT: Record<string, string> = { image: "png", video: "mp4", audio: "mp3" };

/**
 * 手动重试的扩展名裁定（Task 2 裁决）：有旧 workspacePath 沿用其扩展名
 * （限 `[a-z0-9]{1,8}` 正常形态，篡改/异常命名不倒灌进新文件名）；无旧路径按 kind 兜底
 * （failed 行 path 恒 null → 命中此分支）；其余 kind 无兜底返回 null，由路由 400，绝不臆造文件名。
 */
function pickLocalizeExt(asset: ProductionAsset): string | null {
  if (asset.workspacePath) {
    const ext = path.extname(asset.workspacePath).slice(1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) {
      return ext;
    }
  }
  return KIND_FALLBACK_EXT[asset.type] ?? null;
}

export function registerProductionRoutes(app: FastifyInstance, deps: ProductionRouteDeps): void {
  const workflowFeature = requireFeature(deps.membershipService, "workflow.automation");

  /** 项目归属校验（项目 → 工作区 → 当前用户；不匹配 404） */
  const assertProjectOwned = async (projectId: string, userId: string): Promise<void> => {
    const project = await deps.production.getProject(projectId);
    await deps.workspaceService.getOwned(project.workspaceId, userId);
  };

  /** 工作流归属校验 */
  const assertWorkflowOwned = async (workflowId: string, userId: string): Promise<void> => {
    const workflow = (await deps.workflowService.getWorkflow(workflowId)) as { projectId: string };
    await assertProjectOwned(workflow.projectId, userId);
  };

  /** 实体归属校验：实体所属项目必须属于当前用户（不匹配 404） */
  const ownedProjectOf = async (entityProjectId: string, userId: string): Promise<void> => {
    await assertProjectOwned(entityProjectId, userId);
  };

  /**
   * 本地化产物是否真实在场（stat 到普通文件才算）。解析失败/ENOENT/目录伪装一律 false——
   * ready 短路第三条件（终审 I1）：ready 悬空（media 路由 410 形态）时短路失效，
   * 让手动重试落入重下载路径自愈，而非对着不存在的文件回 200。
   */
  const localFilePresent = async (asset: ProductionAsset): Promise<boolean> => {
    if (!asset.workspacePath) return false;
    try {
      const abs = resolveSafeWorkspacePath(
        path.join(deps.workspaceRoot, asset.workspaceId),
        asset.workspacePath,
      );
      const st = await stat(abs);
      return st.isFile();
    } catch {
      return false;
    }
  };

  // ================= 生产项目 CRUD =================

  // 列出当前用户全部工作区的生产项目
  app.get("/api/productions", async (req) => {
    const userId = req.user!.userId;
    // V0.3：工作区概念从产品层移除——项目列表取自用户默认工作区
    const workspace = await deps.workspaceService.ensureDefault(userId);
    return deps.production.listProjects(workspace.id);
  });

  app.post<{ Body: { name?: string; type?: string; description?: string; duration?: number; style?: string } }>(
    "/api/productions",
    async (req) => {
      const userId = req.user!.userId;
      // V0.3：项目自动归属用户默认工作区（无需显式 workspaceId）
      const workspace = await deps.workspaceService.ensureDefault(userId);
      return deps.production.createProject({
        workspaceId: workspace.id,
        name: req.body?.name ?? "",
        type: req.body?.type as never,
        description: req.body?.description,
        settings: { duration: req.body?.duration, style: req.body?.style },
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/productions/:id", async (req) => {
    const userId = req.user!.userId;
    const project = await deps.production.getProject(req.params.id);
    await deps.workspaceService.getOwned(project.workspaceId, userId);
    return project;
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; type?: string; description?: string; status?: string; duration?: number; style?: string } }>(
    "/api/productions/:id",
    async (req) => {
      const userId = req.user!.userId;
      const project = await deps.production.getProject(req.params.id);
      await deps.workspaceService.getOwned(project.workspaceId, userId);
      return deps.production.updateProject(req.params.id, {
        name: req.body?.name,
        type: req.body?.type as never,
        description: req.body?.description,
        status: req.body?.status as never,
        settings:
          req.body?.duration === undefined && req.body?.style === undefined
            ? undefined
            : { duration: req.body?.duration, style: req.body?.style },
      });
    },
  );

  // ================= 实体 CRUD（脚本/角色/场景/分镜/镜头/资产） =================

  // 剧本
  app.get<{ Params: { projectId: string }; Querystring: { episodeId?: string } }>(
    "/api/projects/:projectId/scripts",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.listScripts(req.params.projectId, req.query.episodeId);
    },
  );
  app.post<{ Params: { projectId: string }; Body: { title?: string; content?: string; status?: string; episodeId?: string } }>(
    "/api/projects/:projectId/scripts",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createScript({
        projectId: req.params.projectId,
        episodeId: req.body?.episodeId,
        title: req.body?.title ?? "",
        content: req.body?.content ?? "",
        status: req.body?.status as never,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/scripts/:id", async (req) => {
    const script = await deps.production.getScript(req.params.id);
    await ownedProjectOf(script.projectId, req.user!.userId);
    return script;
  });
  app.patch<{ Params: { id: string }; Body: { title?: string; content?: string; status?: string } }>(
    "/api/scripts/:id",
    async (req) => {
      const script = await deps.production.getScript(req.params.id);
      await ownedProjectOf(script.projectId, req.user!.userId);
      return deps.production.updateScript(req.params.id, {
        title: req.body?.title,
        content: req.body?.content,
        status: req.body?.status as never,
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/scripts/:id", async (req) => {
    const script = await deps.production.getScript(req.params.id);
    await ownedProjectOf(script.projectId, req.user!.userId);
    await deps.production.deleteScript(req.params.id);
    return { ok: true };
  });

  // 角色
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/characters", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listCharacters(req.params.projectId);
  });
  app.post<{
    Params: { projectId: string };
    Body: {
      name?: string;
      description?: string;
      appearance?: Record<string, unknown>;
      personality?: string;
      referenceAssetId?: string;
      visualProfile?: Record<string, unknown>;
      voice?: string;
    };
  }>(
    "/api/projects/:projectId/characters",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createCharacter({
        projectId: req.params.projectId,
        name: req.body?.name ?? "",
        description: req.body?.description ?? "",
        appearance: req.body?.appearance as never,
        personality: req.body?.personality,
        referenceAssetId: req.body?.referenceAssetId,
        visualProfile: req.body?.visualProfile as never,
        voice: req.body?.voice,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/characters/:id", async (req) => {
    const character = await deps.production.getCharacter(req.params.id);
    await ownedProjectOf(character.projectId, req.user!.userId);
    return character;
  });
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      appearance?: Record<string, unknown>;
      personality?: string;
      referenceAssetId?: string;
      visualProfile?: Record<string, unknown>;
      voice?: string;
    };
  }>(
    "/api/characters/:id",
    async (req) => {
      const character = await deps.production.getCharacter(req.params.id);
      await ownedProjectOf(character.projectId, req.user!.userId);
      return deps.production.updateCharacter(req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        appearance: req.body?.appearance as never,
        personality: req.body?.personality,
        referenceAssetId: req.body?.referenceAssetId,
        visualProfile: req.body?.visualProfile as never,
        voice: req.body?.voice,
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/characters/:id", async (req) => {
    const character = await deps.production.getCharacter(req.params.id);
    await ownedProjectOf(character.projectId, req.user!.userId);
    await deps.production.deleteCharacter(req.params.id);
    return { ok: true };
  });

  // 集（短剧多集 V0.3：项目下每集独立剧本/场景/分镜/镜头/成片；角色与资产跨集共享）
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/episodes", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listEpisodes(req.params.projectId);
  });
  app.post<{
    Params: { projectId: string };
    Body: { name?: string; description?: string; order?: number };
  }>(
    "/api/projects/:projectId/episodes",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createEpisode({
        projectId: req.params.projectId,
        name: req.body?.name,
        description: req.body?.description,
        order: req.body?.order,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/episodes/:id", async (req) => {
    const episode = await deps.production.getEpisode(req.params.id);
    await ownedProjectOf(episode.projectId, req.user!.userId);
    return episode;
  });
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; order?: number };
  }>(
    "/api/episodes/:id",
    async (req) => {
      const episode = await deps.production.getEpisode(req.params.id);
      await ownedProjectOf(episode.projectId, req.user!.userId);
      return deps.production.updateEpisode(req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        order: req.body?.order,
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/episodes/:id", async (req) => {
    const episode = await deps.production.getEpisode(req.params.id);
    await ownedProjectOf(episode.projectId, req.user!.userId);
    await deps.production.deleteEpisode(req.params.id);
    return { ok: true };
  });

  // 场景
  app.get<{ Params: { projectId: string }; Querystring: { episodeId?: string } }>(
    "/api/projects/:projectId/scenes",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.listScenes(req.params.projectId, req.query.episodeId);
    },
  );
  app.post<{
    Params: { projectId: string };
    Body: {
      name?: string;
      description?: string;
      episodeId?: string;
      scriptId?: string;
      location?: string;
      time?: string;
      characters?: string[];
      order?: number;
      visualStyle?: Record<string, unknown>;
    };
  }>(
    "/api/projects/:projectId/scenes",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createScene({
        projectId: req.params.projectId,
        episodeId: req.body?.episodeId,
        name: req.body?.name ?? "",
        description: req.body?.description ?? "",
        scriptId: req.body?.scriptId,
        location: req.body?.location,
        time: req.body?.time,
        characters: req.body?.characters,
        order: req.body?.order,
        visualStyle: req.body?.visualStyle as never,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/scenes/:id", async (req) => {
    const scene = await deps.production.getScene(req.params.id);
    await ownedProjectOf(scene.projectId, req.user!.userId);
    return scene;
  });
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      scriptId?: string;
      location?: string;
      time?: string;
      characters?: string[];
      order?: number;
      visualStyle?: Record<string, unknown>;
    };
  }>(
    "/api/scenes/:id",
    async (req) => {
      const scene = await deps.production.getScene(req.params.id);
      await ownedProjectOf(scene.projectId, req.user!.userId);
      return deps.production.updateScene(req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        scriptId: req.body?.scriptId,
        location: req.body?.location,
        time: req.body?.time,
        characters: req.body?.characters,
        order: req.body?.order,
        visualStyle: req.body?.visualStyle as never,
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/scenes/:id", async (req) => {
    const scene = await deps.production.getScene(req.params.id);
    await ownedProjectOf(scene.projectId, req.user!.userId);
    await deps.production.deleteScene(req.params.id);
    return { ok: true };
  });

  // 分镜
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/storyboards", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listStoryboards(req.params.projectId);
  });
  app.post<{
    Params: { projectId: string };
    Body: {
      sceneId?: string;
      description?: string;
      duration?: number;
      shotType?: string;
      cameraMovement?: string;
      imagePrompt?: string;
      videoPrompt?: string;
      order?: number;
      status?: string;
    };
  }>(
    "/api/projects/:projectId/storyboards",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createStoryboard({
        projectId: req.params.projectId,
        sceneId: req.body?.sceneId ?? "",
        description: req.body?.description ?? "",
        duration: req.body?.duration ?? 5,
        shotType: req.body?.shotType ?? "",
        cameraMovement: req.body?.cameraMovement,
        imagePrompt: req.body?.imagePrompt,
        videoPrompt: req.body?.videoPrompt,
        order: req.body?.order,
        status: req.body?.status as never,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/storyboards/:id", async (req) => {
    const storyboard = await deps.production.getStoryboard(req.params.id);
    await ownedProjectOf(storyboard.projectId, req.user!.userId);
    return storyboard;
  });
  app.patch<{
    Params: { id: string };
    Body: {
      description?: string;
      duration?: number;
      shotType?: string;
      cameraMovement?: string;
      imagePrompt?: string;
      videoPrompt?: string;
      status?: string;
      order?: number;
    };
  }>(
    "/api/storyboards/:id",
    async (req) => {
      const storyboard = await deps.production.getStoryboard(req.params.id);
      await ownedProjectOf(storyboard.projectId, req.user!.userId);
      return deps.production.updateStoryboard(req.params.id, {
        description: req.body?.description,
        duration: req.body?.duration,
        shotType: req.body?.shotType,
        cameraMovement: req.body?.cameraMovement,
        imagePrompt: req.body?.imagePrompt,
        videoPrompt: req.body?.videoPrompt,
        status: req.body?.status as never,
        order: req.body?.order,
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/storyboards/:id", async (req) => {
    const storyboard = await deps.production.getStoryboard(req.params.id);
    await ownedProjectOf(storyboard.projectId, req.user!.userId);
    await deps.production.deleteStoryboard(req.params.id);
    return { ok: true };
  });

  // 镜头（按项目列出，前端按分镜分组；多集可经 episodeId 过滤）
  app.get<{ Params: { projectId: string }; Querystring: { episodeId?: string } }>(
    "/api/projects/:projectId/shots",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.listShots(req.params.projectId, req.query.episodeId);
    },
  );
  app.post<{
    Params: { projectId: string };
    Body: {
      storyboardId?: string;
      duration?: number;
      order?: number;
      framing?: string;
      cameraMovement?: string;
      action?: string;
      dialogue?: string;
      visualStyle?: Record<string, unknown>;
    };
  }>(
    "/api/projects/:projectId/shots",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createShot({
        projectId: req.params.projectId,
        storyboardId: req.body?.storyboardId ?? "",
        duration: req.body?.duration ?? 3,
        order: req.body?.order,
        framing: req.body?.framing,
        cameraMovement: req.body?.cameraMovement,
        action: req.body?.action,
        dialogue: req.body?.dialogue,
        visualStyle: req.body?.visualStyle as never,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/shots/:id", async (req) => {
    const shot = await deps.production.getShot(req.params.id);
    await ownedProjectOf(shot.projectId, req.user!.userId);
    return shot;
  });
  app.patch<{
    Params: { id: string };
    Body: {
      status?: string;
      duration?: number;
      order?: number;
      framing?: string;
      cameraMovement?: string;
      action?: string;
      dialogue?: string;
      imageAssetId?: string;
      videoAssetId?: string;
      audioAssetId?: string;
      visualStyle?: Record<string, unknown>;
    };
  }>(
    "/api/shots/:id",
    async (req) => {
      const shot = await deps.production.getShot(req.params.id);
      await ownedProjectOf(shot.projectId, req.user!.userId);
      return deps.production.updateShot(req.params.id, {
        status: req.body?.status as never,
        duration: req.body?.duration,
        order: req.body?.order,
        framing: req.body?.framing,
        cameraMovement: req.body?.cameraMovement,
        action: req.body?.action,
        dialogue: req.body?.dialogue,
        imageAssetId: req.body?.imageAssetId,
        videoAssetId: req.body?.videoAssetId,
        audioAssetId: req.body?.audioAssetId,
        visualStyle: req.body?.visualStyle as never,
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/shots/:id", async (req) => {
    const shot = await deps.production.getShot(req.params.id);
    await ownedProjectOf(shot.projectId, req.user!.userId);
    await deps.production.deleteShot(req.params.id);
    return { ok: true };
  });

  // 资产
  app.get<{ Params: { projectId: string }; Querystring: { type?: string } }>(
    "/api/projects/:projectId/assets",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.listAssets(req.params.projectId, req.query.type as never);
    },
  );
  // 手动录入资产（制作中心引用外部素材）：类型/名称/URL/媒体类型
  app.post<{
    Params: { projectId: string };
    Body: { type?: string; name?: string; url?: string; mimeType?: string; metadata?: Record<string, unknown> };
  }>(
    "/api/projects/:projectId/assets",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createAsset({
        projectId: req.params.projectId,
        type: req.body?.type as never,
        name: req.body?.name ?? "",
        url: req.body?.url,
        mimeType: req.body?.mimeType,
        metadata: req.body?.metadata,
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const asset = await deps.production.getAsset(req.params.id);
    await ownedProjectOf(asset.projectId, req.user!.userId);
    return asset;
  });
  app.patch<{
    Params: { id: string };
    Body: { name?: string; type?: string; url?: string; mimeType?: string };
  }>(
    "/api/assets/:id",
    async (req) => {
      const asset = await deps.production.getAsset(req.params.id);
      await ownedProjectOf(asset.projectId, req.user!.userId);
      return deps.production.updateAsset(req.params.id, {
        name: req.body?.name,
        type: req.body?.type as never,
        url: req.body?.url,
        mimeType: req.body?.mimeType,
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const asset = await deps.production.getAsset(req.params.id);
    await ownedProjectOf(asset.projectId, req.user!.userId);
    await deps.production.deleteAsset(req.params.id);
    // 转存产物文件清理（spec §8）：仅清本特性写入目录（前缀常量为 worker/server 单一事实源，M①），
    // 用户手放的 workspacePath 不代删；文件失败只记日志绝不抛——行已删，响应照旧 200。
    // resolveSafeWorkspacePath 同 media 纪律：DB 被篡改的越界路径在解析层即拒，不触真实文件系统。
    if (asset.workspacePath?.startsWith(LOCALIZE_DIR_PREFIX)) {
      try {
        const abs = resolveSafeWorkspacePath(
          path.join(deps.workspaceRoot, asset.workspaceId),
          asset.workspacePath,
        );
        await unlink(abs);
      } catch (err) {
        app.log.warn(
          { err, assetId: req.params.id },
          "删除本地化文件失败（文件已丢失或路径越界），不影响删除结果",
        );
      }
    }
    return { ok: true };
  });

  // ---- 手动重试转存（spec §6）：ready 幂等，failed/未转存的远程资产同步下载落本地 ----
  app.post<{ Params: { assetId: string } }>("/api/assets/:assetId/localize", async (req) => {
    const userId = req.user!.userId;
    // 1) 加载 + 归属：不存在/越权/DB 查炸一律收敛同构 404（与 media 路由同款可用性取舍，
    //    不留探测差值）；越权绝不走到下面的 url 判空与下载。
    let asset: ProductionAsset;
    try {
      asset = await deps.production.getAsset(req.params.assetId);
      await ownedProjectOf(asset.projectId, userId);
    } catch {
      throw ASSET_NOT_ACCESSIBLE();
    }

    // 2) b64 直出/纯本地资产：无可下载源 → 400 单独文案（归属校验之后，防被用作存在性探针）
    if (!asset.url) {
      throw ERRORS.INVALID_INPUT("该资产无可下载的远程地址");
    }

    // 3) ready 幂等短路：谓词与 media 一致（path && state 双判）+ 文件在场（stat，终审 I1）；
    //    ready 悬空 → 不短路，落入下面的重下载路径自愈；重下载再失败仍走既有 failed+422
    const meta = asset.metadata?.[LOCALIZE_METADATA_KEY] as LocalizeMetadata | undefined;
    if (asset.workspacePath && meta?.state === "ready" && (await localFilePresent(asset))) {
      return { asset };
    }

    // 4) destPath 组装（同 media 规则）：DB 存相对段 media/<assetId>.<ext>，
    //    root 带 wsId 段；三要素全可信（服务端 id / 白名单式扩展名 / config 根），无注入面。
    const ext = pickLocalizeExt(asset);
    if (!ext) {
      throw ERRORS.INVALID_INPUT("仅 image / video 资产支持本地化转存");
    }
    const relativePath = `${LOCALIZE_DIR_PREFIX}${asset.id}.${ext}`;
    const destPath = path.join(deps.workspaceRoot, asset.workspaceId, relativePath);

    // 并发取舍（有意不上锁）：同资产双击重试、worker 与手动赛跑——文件面靠 localizeToFile
    // 的 part+rename 原子到位（无半文件），DB 面靠 updateAssetFields 后写胜出；与 followups
    // 「并发同 dest 互斥」挂账同源，V1 接受。
    // 最坏时长 = 4 次尝试的网络等待（默认 timeoutMs=60s）+ 退避合计 10.5s + 成功一次的
    // 整文件下载（默认 maxBytes=500MB）；手动重试属小概率路径，V1 接受同步执行（spec §6）。
    const result = await localizeToFile({
      url: asset.url,
      destPath,
      maxBytes: deps.localizeConfig.maxBytes,
      timeoutMs: deps.localizeConfig.timeoutMs,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });

    const baseMetadata: Record<string, unknown> = asset.metadata ?? {};
    if (!result.ok) {
      // 先收敛 DB 再回话（与 worker 宽落库语义对齐）：UI「未存本地 + 重试」角标依赖此键；
      // 失败不动 workspacePath（Task 2 契约：failed 行 path 恒 null 的起点在此保持）。
      await deps.production.updateAssetFields(asset.id, {
        metadata: {
          ...baseMetadata,
          [LOCALIZE_METADATA_KEY]: {
            state: "failed",
            error: result.error,
            at: new Date().toISOString(),
          } satisfies LocalizeMetadata,
        },
      });
      throw new ServerError("LOCALIZE_FAILED", result.error, 422);
    }

    const fields: AssetFieldsPatch = {
      workspacePath: relativePath,
      metadata: {
        ...baseMetadata,
        [LOCALIZE_METADATA_KEY]: {
          state: "ready",
          bytes: result.bytes,
          at: new Date().toISOString(),
        } satisfies LocalizeMetadata,
      },
    };
    // mimeType 兜正（Task 2 裁决）：Content-Type 命中白名单且 DB 缺省/不符才改写；
    // 未知类型（extFromContentType 返回 null）绝不倒灌。metadata 取入口快照（与 worker
    // M3 覆写风险同源，已挂账 followups：回写前重读或 repo 层 JSON merge）。
    const realExt = extFromContentType(result.contentType);
    const realMime = result.contentType?.split(";")[0]?.trim().toLowerCase();
    const dbMime = asset.mimeType?.trim().toLowerCase();
    if (realExt && realMime && (!dbMime || dbMime !== realMime)) {
      fields.mimeType = realMime;
    }
    return { asset: await deps.production.updateAssetFields(asset.id, fields) };
  });

  // ---- 生成（图片：入队，worker 执行；响应 { task } 任务视图，前端按任务条轮询） ----
  app.post<{ Params: { projectId: string }; Body: { prompt?: string; modelName?: string; size?: string } }>(
    "/api/projects/:projectId/assets/generate-image",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return {
        task: await deps.generationService.enqueueImage({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          prompt: req.body?.prompt ?? "",
          modelName: req.body?.modelName,
          size: req.body?.size,
        }),
      };
    },
  );

  // ---- 生成（视频：入队，worker 执行；响应与图片同形 = { task } 任务视图包装） ----
  app.post<{ Params: { projectId: string }; Body: { prompt?: string; imageUrl?: string; modelName?: string; duration?: number; resolution?: string } }>(
    "/api/projects/:projectId/assets/generate-video",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return {
        task: await deps.generationService.enqueueVideo({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          prompt: req.body?.prompt,
          imageUrl: req.body?.imageUrl,
          modelName: req.body?.modelName,
          duration: req.body?.duration,
          resolution: req.body?.resolution,
        }),
      };
    },
  );
  // ---- 生成（配音：TTS 入队，worker 执行；响应同形 { task }） ----
  app.post<{ Params: { projectId: string }; Body: { prompt?: string; voice?: string; modelName?: string } }>(
    "/api/projects/:projectId/assets/generate-audio",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return {
        task: await deps.generationService.enqueueAudio({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          prompt: req.body?.prompt ?? "",
          voice: req.body?.voice,
          modelName: req.body?.modelName,
        }),
      };
    },
  );
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req) => {
    const task = deps.generationService.getTask(req.params.id);
    await ownedProjectOf(task.projectId, req.user!.userId);
    return task;
  });  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req) => {
    const task = deps.generationService.getTask(req.params.id);
    await ownedProjectOf(task.projectId, req.user!.userId);
    await deps.generationService.cancelTask(req.params.id);
    return deps.generationService.getTask(req.params.id);
  });

  // ---- 项目工作流：创建 / 列表 ----
  app.post<{ Params: { projectId: string }; Body: { nodes?: unknown; story?: string; withGeneration?: boolean } }>(
    "/api/projects/:projectId/workflows",
    { preHandler: [workflowFeature] },
    async (req) => {
      const { projectId } = req.params;
      await assertProjectOwned(projectId, req.user!.userId);
      return deps.workflowService.createWorkflow(projectId, req.user!.userId, {
        nodes: req.body?.nodes as never,
        story: req.body?.story,
        withGeneration: req.body?.withGeneration,
      });
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/workflows",
    { preHandler: [workflowFeature] },
    async (req) => {
      const { projectId } = req.params;
      await assertProjectOwned(projectId, req.user!.userId);
      return deps.workflowService.listWorkflows(projectId);
    },
  );

  // ---- 工作流详情 ----
  app.get<{ Params: { id: string } }>(
    "/api/workflows/:id",
    { preHandler: [workflowFeature] },
    async (req) => {
      await assertWorkflowOwned(req.params.id, req.user!.userId);
      return deps.workflowService.getWorkflow(req.params.id);
    },
  );

  // ---- 执行控制 ----
  app.post<{ Params: { id: string }; Body: { sessionId?: string } }>(
    "/api/workflows/:id/run",
    { preHandler: [workflowFeature] },
    async (req) => {
      const { id } = req.params;
      const userId = req.user!.userId;
      await assertWorkflowOwned(id, userId);
      const sessionId = req.body?.sessionId;
      if (!sessionId) {
        throw ERRORS.INVALID_INPUT("sessionId is required");
      }
      const session = await deps.sessionService.get(sessionId);
      await deps.workspaceService.getOwned(session.workspaceId, userId);
      const modelConfig = await deps.settingsService.getEffectiveModelConfig(session, userId);
      return deps.workflowService.runWorkflow(id, {
        sessionId,
        workspaceId: session.workspaceId,
        userId,
        modelConfig,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/workflows/:id/pause",
    { preHandler: [workflowFeature] },
    async (req) => {
      await assertWorkflowOwned(req.params.id, req.user!.userId);
      await deps.workflowService.pauseWorkflow(req.params.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/workflows/:id/resume",
    { preHandler: [workflowFeature] },
    async (req) => {
      await assertWorkflowOwned(req.params.id, req.user!.userId);
      await deps.workflowService.resumeWorkflow(req.params.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/workflows/:id/cancel",
    { preHandler: [workflowFeature] },
    async (req) => {
      await assertWorkflowOwned(req.params.id, req.user!.userId);
      await deps.workflowService.cancelWorkflow(req.params.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; nodeId: string } }>(
    "/api/workflows/:id/nodes/:nodeId/retry",
    { preHandler: [workflowFeature] },
    async (req) => {
      await assertWorkflowOwned(req.params.id, req.user!.userId);
      return deps.workflowService.retryNode(req.params.id, req.params.nodeId);
    },
  );

  // ---- 事件订阅（SSE） ----
  app.get<{ Params: { id: string } }>(
    "/api/workflows/:id/events",
    async (req, reply) => {
      const { id } = req.params;
      const userId = req.user!.userId;
      // 校验必须发生在 hijack 前
      await assertWorkflowOwned(id, userId);
      const isRunning = deps.workflowService.isRunning(id);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);

      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (!raw.destroyed) raw.end();
      };
      const unsubscribe = deps.workflowService.subscribe(id, (event) => {
        writeSSEPayload(raw, event.type, event);
        if (isTerminalWorkflowEvent(event)) {
          close();
        }
      });
      req.raw.on("close", close);

      // 未在运行：推送当前状态快照后关闭
      if (!isRunning) {
        const workflow = (await deps.workflowService.getWorkflow(id)) as Record<string, unknown>;
        writeSSEPayload(raw, "workflow.snapshot", { workflowId: id, ...workflow });
        close();
      }
    },
  );

  // ================= 成片时间轴（V0.3 Phase 2：Timeline / Track / Clip） =================

  /** 时间轴归属校验（timeline → project → workspace → user；不匹配 404） */
  const assertTimelineOwned = async (timelineId: string, userId: string): Promise<void> => {
    const timeline = await deps.timeline.getTimeline(timelineId);
    await assertProjectOwned(timeline.projectId, userId);
  };

  const assertTrackOwned = async (trackId: string, userId: string): Promise<void> => {
    const track = await deps.timeline.getTrack(trackId);
    await assertTimelineOwned(track.timelineId, userId);
  };

  const assertClipOwned = async (clipId: string, userId: string): Promise<void> => {
    const clip = await deps.timeline.getClip(clipId);
    await assertTimelineOwned(clip.timelineId, userId);
  };

  // ---- Timeline ----

  /** 时间轴渲染（Phase 7）：ready → rendering + queued 任务（worker 执行在 Phase 8） */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/render", async (req) => {
    await assertTimelineOwned(req.params.id, req.user!.userId);
    return deps.renderTask.renderTimeline(req.params.id, req.user!.userId);
  });

  /** 自动时间轴（Phase 5）：按项目镜头（scene→storyboard→shot 序）自动生成成片时间轴 */
  app.post<{
    Params: { projectId: string };
    Body: { name?: string; description?: string; fps?: number; width?: number; height?: number; episodeId?: string };
  }>("/api/projects/:projectId/timelines/auto", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.timeline.autoCreateTimeline(req.params.projectId, {
      name: req.body?.name,
      description: req.body?.description,
      fps: req.body?.fps,
      width: req.body?.width,
      height: req.body?.height,
      episodeId: req.body?.episodeId,
    });
  });

  app.post<{
    Params: { projectId: string };
    Body: { name?: string; description?: string; fps?: number; width?: number; height?: number; episodeId?: string };
  }>("/api/projects/:projectId/timelines", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.timeline.createTimeline({
      projectId: req.params.projectId,
      episodeId: req.body?.episodeId,
      name: req.body?.name ?? "",
      description: req.body?.description,
      fps: req.body?.fps,
      width: req.body?.width,
      height: req.body?.height,
    });
  });

  app.get<{ Params: { projectId: string }; Querystring: { episodeId?: string } }>(
    "/api/projects/:projectId/timelines",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.timeline.listTimelines(req.params.projectId, req.query.episodeId);
    },
  );

  app.get<{ Params: { id: string } }>("/api/timelines/:id", async (req) => {
    await assertTimelineOwned(req.params.id, req.user!.userId);
    return deps.timeline.getTimelineDetail(req.params.id);
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      fps?: number;
      width?: number;
      height?: number;
      status?: string;
    };
  }>("/api/timelines/:id", async (req) => {
    await assertTimelineOwned(req.params.id, req.user!.userId);
    return deps.timeline.updateTimeline(req.params.id, {
      name: req.body?.name,
      description: req.body?.description,
      fps: req.body?.fps,
      width: req.body?.width,
      height: req.body?.height,
      status: req.body?.status as never,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/timelines/:id", async (req) => {
    await assertTimelineOwned(req.params.id, req.user!.userId);
    await deps.timeline.deleteTimeline(req.params.id);
    return { ok: true };
  });

  // ---- Track ----

  app.post<{
    Params: { timelineId: string };
    Body: { type?: string; name?: string; order?: number; muted?: boolean; locked?: boolean };
  }>("/api/timelines/:timelineId/tracks", async (req) => {
    await assertTimelineOwned(req.params.timelineId, req.user!.userId);
    return deps.timeline.createTrack({
      timelineId: req.params.timelineId,
      type: req.body?.type as never,
      name: req.body?.name ?? "",
      order: req.body?.order,
      muted: req.body?.muted,
      locked: req.body?.locked,
    });
  });

  app.patch<{
    Params: { id: string };
    Body: { type?: string; name?: string; order?: number; muted?: boolean; locked?: boolean };
  }>("/api/timeline-tracks/:id", async (req) => {
    await assertTrackOwned(req.params.id, req.user!.userId);
    return deps.timeline.updateTrack(req.params.id, {
      type: req.body?.type as never,
      name: req.body?.name,
      order: req.body?.order,
      muted: req.body?.muted,
      locked: req.body?.locked,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/timeline-tracks/:id", async (req) => {
    await assertTrackOwned(req.params.id, req.user!.userId);
    await deps.timeline.deleteTrack(req.params.id);
    return { ok: true };
  });

  // ---- Clip ----

  app.post<{
    Params: { trackId: string };
    Body: {
      assetId?: string;
      shotId?: string;
      startTime?: number;
      duration?: number;
      sourceStartTime?: number;
      sourceDuration?: number;
      order?: number;
      metadata?: Record<string, unknown>;
    };
  }>("/api/timeline-tracks/:trackId/clips", async (req) => {
    await assertTrackOwned(req.params.trackId, req.user!.userId);
    const track = await deps.timeline.getTrack(req.params.trackId);
    const body = req.body ?? {};
    return deps.timeline.createClip({
      timelineId: track.timelineId,
      trackId: req.params.trackId,
      assetId: body.assetId,
      shotId: body.shotId,
      startTime: body.startTime ?? 0,
      duration: body.duration ?? 0,
      sourceStartTime: body.sourceStartTime,
      sourceDuration: body.sourceDuration,
      order: body.order,
      metadata: body.metadata,
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      assetId?: string | null;
      shotId?: string | null;
      startTime?: number;
      duration?: number;
      sourceStartTime?: number;
      sourceDuration?: number;
      order?: number;
      metadata?: Record<string, unknown>;
    };
  }>("/api/timeline-clips/:id", async (req) => {
    await assertClipOwned(req.params.id, req.user!.userId);
    const body = req.body ?? {};
    return deps.timeline.updateClip(req.params.id, {
      assetId: body.assetId,
      shotId: body.shotId,
      startTime: body.startTime,
      duration: body.duration,
      sourceStartTime: body.sourceStartTime,
      sourceDuration: body.sourceDuration,
      order: body.order,
      metadata: body.metadata,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/timeline-clips/:id", async (req) => {
    await assertClipOwned(req.params.id, req.user!.userId);
    await deps.timeline.deleteClip(req.params.id);
    return { ok: true };
  });
}
