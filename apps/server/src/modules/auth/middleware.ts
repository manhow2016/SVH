import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AuthService } from "./service";
import type { UserRole } from "./types";
import { ERRORS } from "../../lib/errors";

/** 功能权限检查接口（由 MembershipService 实现，依赖倒置） */
export interface FeatureChecker {
  assertFeature(userId: string, featureCode: string): Promise<void>;
}

/**
 * 认证中间件（文档 §18/§22）：
 * - authenticate：从 Authorization: Bearer 解析 JWT，加载用户并挂载 request.user
 * - requireAdmin：仅 admin 角色
 * - requireFeature：会员功能权限（后端权威校验，文档 §19/§33）
 */
export function createAuthenticate(authService: AuthService) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw ERRORS.UNAUTHORIZED();
    }
    const payload = await authService.verifyToken(header.slice("Bearer ".length));
    const user = await authService.getUserForAuth(payload.userId);
    if (!user) throw ERRORS.UNAUTHORIZED();
    if (user.status === "disabled") throw ERRORS.USER_DISABLED();
    request.user = {
      userId: user.id,
      role: user.role as UserRole,
      username: user.username,
    };
  };
}

/** 管理员守卫（文档 §24） */
export function requireAdmin(): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    if (request.user?.role !== "admin") {
      throw ERRORS.FORBIDDEN("需要管理员权限");
    }
  };
}

/** 功能权限守卫（文档 §18） */
export function requireFeature(
  membershipService: FeatureChecker,
  featureCode: string,
): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    if (!request.user) throw ERRORS.UNAUTHORIZED();
    await membershipService.assertFeature(request.user.userId, featureCode);
  };
}
