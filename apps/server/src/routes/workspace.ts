import type { FastifyInstance } from "fastify";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS } from "../lib/errors";

export interface WorkspaceRouteDeps {
  workspaceService: WorkspaceService;
  log: FastifyInstance["log"];
}

/** Workspace API（文档 §28） */
export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  // 创建
  app.post<{ Body: { name?: string } }>("/api/workspaces", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) throw ERRORS.INVALID_INPUT("name is required");
    const workspace = await deps.workspaceService.create(name);
    deps.log.info({ workspaceId: workspace.id, name: workspace.name }, "workspace created");
    return reply.code(201).send(workspace);
  });

  // 列表
  app.get("/api/workspaces", async () => deps.workspaceService.list());

  // 获取
  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (req) =>
    deps.workspaceService.get(req.params.id),
  );

  // 删除
  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (req, reply) => {
    await deps.workspaceService.delete(req.params.id);
    deps.log.info({ workspaceId: req.params.id }, "workspace deleted");
    return reply.code(204).send();
  });
}
