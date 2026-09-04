import type { FastifyInstance } from "fastify";
import type { SessionService } from "../modules/session/service";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS } from "../lib/errors";

export interface SessionRouteDeps {
  sessionService: SessionService;
  workspaceService: WorkspaceService;
  log: FastifyInstance["log"];
}

/** Session API（文档 §29） */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  // 创建
  app.post<{ Params: { workspaceId: string }; Body: { title?: string } }>(
    "/api/workspaces/:workspaceId/sessions",
    async (req, reply) => {
      const workspace = await deps.workspaceService.get(req.params.workspaceId);
      const session = await deps.sessionService.create(workspace.id, { title: req.body?.title });
      deps.log.info({ sessionId: session.id, workspaceId: workspace.id }, "session created");
      return reply.code(201).send(session);
    },
  );

  // 获取列表
  app.get<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/sessions", async (req) => {
    await deps.workspaceService.get(req.params.workspaceId);
    return deps.sessionService.list(req.params.workspaceId);
  });

  // 获取详情
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req) =>
    deps.sessionService.get(req.params.id),
  );

  // 更新（title / modelProviderId / modelId）
  app.patch<{ Params: { id: string }; Body: { title?: string; modelProviderId?: string; modelId?: string } }>(
    "/api/sessions/:id",
    async (req) => deps.sessionService.update(req.params.id, req.body ?? {}),
  );

  // 删除
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    await deps.sessionService.delete(req.params.id);
    deps.log.info({ sessionId: req.params.id }, "session deleted");
    return reply.code(204).send();
  });

  // 消息历史
  app.get<{ Params: { id: string } }>("/api/sessions/:id/messages", async (req) =>
    deps.sessionService.listMessages(req.params.id),
  );
}
