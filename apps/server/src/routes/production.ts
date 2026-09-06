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
