import type { FastifyInstance } from "fastify";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS } from "../lib/errors";

export interface WorkspaceRouteDeps {
  workspaceService: WorkspaceService;
  log: FastifyInstance["log"];
}

/** Workspace API（文档 §28 + §20 用户隔离） */
export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  // 创建
  app.post<{ Body: { name?: string } }>("/api/workspaces", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) throw ERRORS.INVALID_INPUT("name is required");
    const workspace = await deps.workspaceService.create(name, req.user!.userId);
    deps.log.info({ workspaceId: workspace.id, name: workspace.name }, "workspace created");
    return reply.code(201).send(workspace);
  });

  // 列表（仅当前用户）
  app.get("/api/workspaces", async (req) =>
    deps.workspaceService.listForUser(req.user!.userId),
  );

  // 获取
  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (req) =>
    deps.workspaceService.getOwned(req.params.id, req.user!.userId),
  );

  // 删除
  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (req, reply) => {
    await deps.workspaceService.deleteOwned(req.params.id, req.user!.userId);
    deps.log.info({ workspaceId: req.params.id }, "workspace deleted");
    return reply.code(204).send();
  });
}
