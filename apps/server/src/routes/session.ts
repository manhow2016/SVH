import type { FastifyInstance } from "fastify";
import type { SessionService } from "../modules/session/service";
import type { WorkspaceService } from "../modules/workspace/service";

export interface SessionRouteDeps {
  sessionService: SessionService;
  workspaceService: WorkspaceService;
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

/** Session API（文档 §29 + 用户隔离） */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  // 创建
  app.post<{ Params: { workspaceId: string }; Body: { title?: string } }>(
    "/api/workspaces/:workspaceId/sessions",
    async (req, reply) => {
      const workspace = await deps.workspaceService.getOwned(
        req.params.workspaceId,
        req.user!.userId,
      );
      const session = await deps.sessionService.create(workspace.id, { title: req.body?.title });
      deps.log.info({ sessionId: session.id, workspaceId: workspace.id }, "session created");
      return reply.code(201).send(session);
    },
  );

  // 获取列表
  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/sessions",
    async (req) => {
      await deps.workspaceService.getOwned(req.params.workspaceId, req.user!.userId);
      return deps.sessionService.list(req.params.workspaceId);
    },
  );

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
