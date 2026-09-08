import type { FastifyInstance } from "fastify";
import type { ProductionService } from "@svh/production";
import type { SessionService } from "../modules/session/service";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS } from "../lib/errors";

export interface SessionRouteDeps {
  sessionService: SessionService;
  workspaceService: WorkspaceService;
  /** 项目归属校验：会话只允许挂到当前用户可访问的项目 */
  productionService: ProductionService;
  log: FastifyInstance["log"];
}

/** 会话级所有权校验：Session → Workspace → 当前用户（文档 §20/§37） */
async function assertSessionOwner(
  deps: SessionRouteDeps,
  sessionId: string,
  userId: string,
): Promise<void> {
  const session = await deps.sessionService.get(sessionId);
  await deps.workspaceService.getOwned(session.workspaceId, userId);
}

/** 项目归属校验：Project → Workspace → 当前用户 */
async function assertProjectOwner(
  deps: SessionRouteDeps,
  projectId: string,
  userId: string,
): Promise<void> {
  const project = await deps.productionService.getProject(projectId);
  await deps.workspaceService.getOwned(project.workspaceId, userId);
}

/**
 * Session API（V0.3：会话与生产项目一对一绑定，用户不可新建会话）。
 * 创建为「按项目获取或创建」的幂等语义——项目创建/进入详情时自动绑定，
 * 重复调用不产生新会话；无 projectId 的请求一律拒绝。
 */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  // 创建/获取项目绑定会话（幂等：项目已有会话则直接返回）
  app.post<{ Body: { projectId?: string; title?: string } }>(
    "/api/sessions",
    async (req, reply) => {
      const projectId = req.body?.projectId;
      if (!projectId) {
        throw ERRORS.INVALID_INPUT("projectId 必填：会话与生产项目绑定，不允许单独新建");
      }
      await assertProjectOwner(deps, projectId, req.user!.userId);
      const workspace = await deps.workspaceService.ensureDefault(req.user!.userId);
      const session = await deps.sessionService.getOrCreateForProject(
        workspace.id,
        projectId,
        req.body?.title,
      );
      deps.log.info({ sessionId: session.id, projectId }, "project session ensured");
      return reply.code(201).send(session);
    },
  );

  // 项目会话列表（项目必须存在且归属当前用户）
  app.get<{ Querystring: { projectId?: string } }>("/api/sessions", async (req) => {
    const projectId = req.query.projectId;
    if (!projectId) {
      throw ERRORS.INVALID_INPUT("projectId 必填：请按项目查询会话");
    }
    await assertProjectOwner(deps, projectId, req.user!.userId);
    return deps.sessionService.listByProject(projectId);
  });

  // 获取详情
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
    await assertSessionOwner(deps, req.params.id, req.user!.userId);
    return deps.sessionService.get(req.params.id);
  });

  // 更新（title / modelProviderId / modelId）
  app.patch<{
    Params: { id: string };
    Body: { title?: string; modelProviderId?: string; modelId?: string };
  }>("/api/sessions/:id", async (req) => {
    await assertSessionOwner(deps, req.params.id, req.user!.userId);
    return deps.sessionService.update(req.params.id, req.body ?? {});
  });

  // 删除
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    await assertSessionOwner(deps, req.params.id, req.user!.userId);
    await deps.sessionService.delete(req.params.id);
    deps.log.info({ sessionId: req.params.id }, "session deleted");
    return reply.code(204).send();
  });

  // 消息历史
  app.get<{ Params: { id: string } }>("/api/sessions/:id/messages", async (req) => {
    await assertSessionOwner(deps, req.params.id, req.user!.userId);
    return deps.sessionService.listMessages(req.params.id);
  });
}
