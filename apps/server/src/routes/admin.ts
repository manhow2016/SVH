import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { UserService } from "../modules/user/service";
import type { FeatureService, SetTierFeatureInput } from "../modules/membership/feature-service";
import { ERRORS } from "../lib/errors";
import type { UserRole, UserStatus } from "../modules/auth/types";

export interface AdminRouteDeps {
  userService: UserService;
  featureService: FeatureService;
  /** 认证中间件（组合时由 app.ts 传入） */
  authenticate: preHandlerHookHandler;
  requireAdminGuard: preHandlerHookHandler;
}

/**
 * 管理员 API（文档 §24/§26）。
 *
 * 当前实现：用户管理 + 会员等级/功能/等级功能关联配置。
 * 套餐 / 活动 / 订阅开通在 Phase 5/6 继续追加到本文件。
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const admin = [deps.authenticate, deps.requireAdminGuard] as const;

  // ==================== 用户管理 ====================
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

  // ==================== 会员等级（§25/§26） ====================
  app.get("/api/admin/membership/tiers", { preHandler: [...admin] }, async () => {
    const tiers = await deps.featureService.listTiers();
    const result = [];
    for (const tier of tiers) {
      result.push({ ...tier, features: await deps.featureService.getTierFeatures(tier.id) });
    }
    return { tiers: result };
  });

  app.post<{
    Body: { code?: string; name?: string; description?: string; sortOrder?: number; enabled?: boolean };
  }>("/api/admin/membership/tiers", { preHandler: [...admin] }, async (req, reply) => {
    const b = req.body ?? {};
    const tier = await deps.featureService.createTier({
      code: b.code ?? "",
      name: b.name ?? "",
      description: b.description,
      sortOrder: b.sortOrder,
      enabled: b.enabled,
    });
    return reply.code(201).send({ tier });
  });

  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; sortOrder?: number; enabled?: boolean };
  }>("/api/admin/membership/tiers/:id", { preHandler: [...admin] }, async (req) => {
    const tier = await deps.featureService.updateTier(req.params.id, req.body ?? {});
    return { tier };
  });

  // ==================== 功能（§26） ====================
  app.get("/api/admin/membership/features", { preHandler: [...admin] }, async () => ({
    features: await deps.featureService.listFeatures(),
  }));

  app.post<{ Body: { code?: string; name?: string; description?: string } }>(
    "/api/admin/membership/features",
    { preHandler: [...admin] },
    async (req, reply) => {
      const b = req.body ?? {};
      const feature = await deps.featureService.createFeature({
        code: b.code ?? "",
        name: b.name ?? "",
        description: b.description,
      });
      return reply.code(201).send({ feature });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string };
  }>("/api/admin/membership/features/:id", { preHandler: [...admin] }, async (req) => {
    const feature = await deps.featureService.updateFeature(req.params.id, req.body ?? {});
    return { feature };
  });

  // 等级功能关联（§25 PUT /tiers/:id/features 全量覆盖）
  app.get(
    "/api/admin/membership/tiers/:id/features",
    { preHandler: [...admin] },
    async (req) => ({
      features: await deps.featureService.getTierFeatures((req.params as { id: string }).id),
    }),
  );

  app.put<{
    Params: { id: string };
    Body: { features?: SetTierFeatureInput[] };
  }>("/api/admin/membership/tiers/:id/features", { preHandler: [...admin] }, async (req) => {
    const items = req.body?.features;
    if (!Array.isArray(items)) throw ERRORS.INVALID_INPUT("features is required");
    await deps.featureService.setTierFeatures(req.params.id, items);
    return { features: await deps.featureService.getTierFeatures(req.params.id) };
  });
}
