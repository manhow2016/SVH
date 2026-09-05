import type { FastifyInstance } from "fastify";
import type { WorkspaceService } from "../modules/workspace/service";
import type { MembershipService } from "../modules/membership/service";
import { ERRORS } from "../lib/errors";

export interface WorkspaceRouteDeps {
  workspaceService: WorkspaceService;
  membershipService: MembershipService;
  log: FastifyInstance["log"];
}

/** Workspace API（文档 §28 + §20 用户隔离 + §21 资源限制） */
export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  // 创建（受会员配置 maxWorkspaces 限制，§20/§21 —— 软件资源限制，非 Token 限制）
  app.post<{ Body: { name?: string } }>("/api/workspaces", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) throw ERRORS.INVALID_INPUT("name is required");
    const userId = req.user!.userId;

    const limit = await deps.membershipService.getResourceLimit(userId, "maxWorkspaces");
    if (limit !== undefined && limit >= 0) {
      const count = (await deps.workspaceService.listForUser(userId)).length;
      if (count >= limit) {
        const membership = await deps.membershipService.getCurrentMembership(userId);
        throw ERRORS.RESOURCE_LIMIT_EXCEEDED(
          `「${membership.tier.name}」最多创建 ${limit} 个工作区，升级会员解锁更多`,
        );
      }
    }

    const workspace = await deps.workspaceService.create(name, userId);
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
