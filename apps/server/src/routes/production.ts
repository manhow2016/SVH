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
import { isTerminalWorkflowEvent } from "@svh/core";
import type { ProductionService } from "@svh/production";
import type { WorkflowService } from "../modules/production/workflow-service";
import type { WorkspaceService } from "../modules/workspace/service";
import type { SessionService } from "../modules/session/service";
import type { SettingsService } from "../modules/settings/service";
import type { MembershipService } from "../modules/membership/service";
import { requireFeature } from "../modules/auth/middleware";
import { writeSSEPayload } from "../lib/sse";
import { ERRORS } from "../lib/errors";

export interface ProductionRouteDeps {
  workflowService: WorkflowService;
  production: ProductionService;
  workspaceService: WorkspaceService;
  sessionService: SessionService;
  settingsService: SettingsService;
  membershipService: MembershipService;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

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

  // ================= 生产项目 CRUD =================

  // 列出当前用户全部工作区的生产项目
  app.get("/api/productions", async (req) => {
    const userId = req.user!.userId;
    const workspaces = await deps.workspaceService.listForUser(userId);
    const projects = await Promise.all(
      workspaces.map((ws) => deps.production.listProjects(ws.id)),
    );
    return projects.flat();
  });

  app.post<{ Body: { workspaceId?: string; name?: string; type?: string; description?: string; duration?: number; style?: string } }>(
    "/api/productions",
    async (req) => {
      const userId = req.user!.userId;
      const workspaceId = req.body?.workspaceId;
      if (!workspaceId) {
        throw ERRORS.INVALID_INPUT("workspaceId is required");
      }
      await deps.workspaceService.getOwned(workspaceId, userId);
      return deps.production.createProject({
        workspaceId,
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
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/scripts", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listScripts(req.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: { title?: string; content?: string; status?: string } }>(
    "/api/projects/:projectId/scripts",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createScript({
        projectId: req.params.projectId,
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

  // 角色
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/characters", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listCharacters(req.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: { name?: string; description?: string; appearance?: Record<string, unknown>; personality?: string } }>(
    "/api/projects/:projectId/characters",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createCharacter({
        projectId: req.params.projectId,
        name: req.body?.name ?? "",
        description: req.body?.description ?? "",
        appearance: req.body?.appearance as never,
        personality: req.body?.personality,
      });
    },
  );
  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; appearance?: Record<string, unknown>; personality?: string } }>(
    "/api/characters/:id",
    async (req) => {
      const character = await deps.production.getCharacter(req.params.id);
      await ownedProjectOf(character.projectId, req.user!.userId);
      return deps.production.updateCharacter(req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        appearance: req.body?.appearance as never,
        personality: req.body?.personality,
      });
    },
  );

  // 场景
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/scenes", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listScenes(req.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: { name?: string; description?: string; scriptId?: string; location?: string; time?: string; characters?: string[] } }>(
    "/api/projects/:projectId/scenes",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createScene({
        projectId: req.params.projectId,
        name: req.body?.name ?? "",
        description: req.body?.description ?? "",
        scriptId: req.body?.scriptId,
        location: req.body?.location,
        time: req.body?.time,
        characters: req.body?.characters,
      });
    },
  );
  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; scriptId?: string; location?: string; time?: string; characters?: string[] } }>(
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
      });
    },
  );

  // 分镜
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/storyboards", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listStoryboards(req.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: { sceneId?: string; description?: string; duration?: number; shotType?: string; cameraMovement?: string; imagePrompt?: string; videoPrompt?: string } }>(
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
      });
    },
  );
  app.patch<{ Params: { id: string }; Body: { description?: string; duration?: number; shotType?: string; cameraMovement?: string; imagePrompt?: string; videoPrompt?: string; status?: string } }>(
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
      });
    },
  );

  // 镜头（按项目列出，前端按分镜分组）
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/shots", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    return deps.production.listShots(req.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: { storyboardId?: string; duration?: number; framing?: string; cameraMovement?: string; action?: string; dialogue?: string } }>(
    "/api/projects/:projectId/shots",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.createShot({
        projectId: req.params.projectId,
        storyboardId: req.body?.storyboardId ?? "",
        duration: req.body?.duration ?? 3,
        framing: req.body?.framing,
        cameraMovement: req.body?.cameraMovement,
        action: req.body?.action,
        dialogue: req.body?.dialogue,
      });
    },
  );
  app.patch<{ Params: { id: string }; Body: { status?: string } }>(
    "/api/shots/:id",
    async (req) => {
      const shot = await deps.production.getShot(req.params.id);
      await ownedProjectOf(shot.projectId, req.user!.userId);
      return deps.production.updateShot(req.params.id, { status: req.body?.status as never });
    },
  );

  // 资产
  app.get<{ Params: { projectId: string }; Querystring: { type?: string } }>(
    "/api/projects/:projectId/assets",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      return deps.production.listAssets(req.params.projectId, req.query.type as never);
    },
  );
  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const asset = await deps.production.getAsset(req.params.id);
    await ownedProjectOf(asset.projectId, req.user!.userId);
    await deps.production.deleteAsset(req.params.id);
    return { ok: true };
  });

  // ---- 项目工作流：创建 / 列表 ----
  app.post<{ Params: { projectId: string }; Body: { nodes?: unknown; story?: string } }>(
    "/api/projects/:projectId/workflows",
    { preHandler: [workflowFeature] },
    async (req) => {
      const { projectId } = req.params;
      await assertProjectOwned(projectId, req.user!.userId);
      return deps.workflowService.createWorkflow(projectId, req.user!.userId, {
        nodes: req.body?.nodes as never,
        story: req.body?.story,
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
}
