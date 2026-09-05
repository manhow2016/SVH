import type { FastifyInstance } from "fastify";
import type { UserService } from "../modules/user/service";
import type { preHandlerHookHandler } from "fastify";
import { ERRORS } from "../lib/errors";
import type { UserRole, UserStatus } from "../modules/auth/types";

export interface AdminRouteDeps {
  userService: UserService;
  /** 认证中间件（组合时由 app.ts 传入） */
  authenticate: preHandlerHookHandler;
  requireAdminGuard: preHandlerHookHandler;
}

/**
 * 管理员 API（文档 §24）。
 *
 * 会员等级 / 功能 / 套餐 / 活动 / 订阅的管理接口在后续 Phase 中继续
 * 追加到本文件（registerAdminRoutes 由 app.ts 组合完整依赖）。
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const admin = [deps.authenticate, deps.requireAdminGuard] as const;

  // ---- 用户管理 ----
  app.get<{ Querystring: { keyword?: string } }>(
    "/api/admin/users",
    { preHandler: [...admin] },
    async (req) => {
      const rows = await deps.userService.list(req.query.keyword);
      return { users: rows.map((u) => deps.userService.toPublic(u)) };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { status?: UserStatus; role?: UserRole };
  }>("/api/admin/users/:id", { preHandler: [...admin] }, async (req) => {
    const target = await deps.userService.getById(req.params.id);
    if (!target) throw ERRORS.INVALID_INPUT("用户不存在");
    if (req.body?.status && !["active", "disabled"].includes(req.body.status)) {
      throw ERRORS.INVALID_INPUT("status 只能是 active / disabled");
    }
    if (req.body?.role && !["user", "admin"].includes(req.body.role)) {
      throw ERRORS.INVALID_INPUT("role 只能是 user / admin");
    }
    const updated = await deps.userService.update(req.params.id, {
      status: req.body?.status,
      role: req.body?.role,
    });
    return { user: deps.userService.toPublic(updated) };
  });
}
