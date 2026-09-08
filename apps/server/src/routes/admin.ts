import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { UserService } from "../modules/user/service";
import type { FeatureService, SetTierFeatureInput } from "../modules/membership/feature-service";
import type {
  SubscriptionPlanService,
  SubscriptionService,
} from "../modules/membership/subscription-service";
import type { PromotionService } from "../modules/membership/promotion-service";
import type { ModelInput, ModelService } from "../modules/settings/model-service";
import { ERRORS } from "../lib/errors";
import type { UserRole, UserStatus } from "../modules/auth/types";

export interface AdminRouteDeps {
  userService: UserService;
  featureService: FeatureService;
  planService: SubscriptionPlanService;
  subscriptionService: SubscriptionService;
  promotionService: PromotionService;
  modelService: ModelService;
  /** 认证中间件（组合时由 app.ts 传入） */
  authenticate: preHandlerHookHandler;
  requireAdminGuard: preHandlerHookHandler;
}

/**
 * 管理员 API（文档 §24/§26）。
 *
 * 实现：用户管理 + 会员等级/功能配置 + 套餐 + 订阅开通 + 活动折扣。
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

  // ==================== 套餐（§26） ====================
  app.get("/api/admin/membership/plans", { preHandler: [...admin] }, async () => ({
    plans: await deps.planService.listAll(),
  }));

  app.post<{
    Body: {
      tierId?: string;
      tierCode?: string;
      name?: string;
      description?: string;
      durationDays?: number;
      originalPrice?: number;
      currency?: string;
      enabled?: boolean;
      sortOrder?: number;
    };
  }>("/api/admin/membership/plans", { preHandler: [...admin] }, async (req, reply) => {
    const b = req.body ?? {};
    const plan = await deps.planService.create({
      tierId: b.tierId,
      tierCode: b.tierCode,
      name: b.name ?? "",
      description: b.description,
      durationDays: b.durationDays ?? 0,
      originalPrice: b.originalPrice ?? 0,
      currency: b.currency,
      enabled: b.enabled,
      sortOrder: b.sortOrder,
    });
    return reply.code(201).send({ plan });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      durationDays?: number;
      originalPrice?: number;
      currency?: string;
      enabled?: boolean;
      sortOrder?: number;
    };
  }>("/api/admin/membership/plans/:id", { preHandler: [...admin] }, async (req) => {
    const plan = await deps.planService.update(req.params.id, req.body ?? {});
    return { plan };
  });

  // ==================== 订阅（§24/§27） ====================
  app.get("/api/admin/subscriptions", { preHandler: [...admin] }, async () => ({
    subscriptions: await deps.subscriptionService.listAll(),
  }));

  // 管理员手动开通会员（V1 无支付系统，§27）
  app.post<{ Body: { userId?: string; planId?: string } }>(
    "/api/admin/subscriptions/grant",
    { preHandler: [...admin] },
    async (req, reply) => {
      const { userId, planId } = req.body ?? {};
      if (!userId || !planId) throw ERRORS.INVALID_INPUT("userId and planId are required");
      const result = await deps.subscriptionService.grant(userId, planId);
      return reply.code(201).send(result);
    },
  );

  // ==================== 活动与折扣（§26） ====================
  app.get("/api/admin/promotions", { preHandler: [...admin] }, async () => ({
    promotions: await deps.promotionService.listAll(),
  }));

  app.post<{
    Body: {
      name?: string;
      description?: string;
      discountType?: string;
      discountValue?: number;
      startedAt?: number;
      endedAt?: number | null;
      enabled?: boolean;
      priority?: number;
      planIds?: string[];
    };
  }>("/api/admin/promotions", { preHandler: [...admin] }, async (req, reply) => {
    const b = req.body ?? {};
    const promotion = await deps.promotionService.create({
      name: b.name ?? "",
      description: b.description,
      discountType: b.discountType ?? "",
      discountValue: b.discountValue ?? 0,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      enabled: b.enabled,
      priority: b.priority,
      planIds: b.planIds,
    });
    return reply.code(201).send({ promotion });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      discountType?: string;
      discountValue?: number;
      startedAt?: number;
      endedAt?: number | null;
      enabled?: boolean;
      priority?: number;
      planIds?: string[];
    };
  }>("/api/admin/promotions/:id", { preHandler: [...admin] }, async (req) => {
    const promotion = await deps.promotionService.update(req.params.id, req.body ?? {});
    return { promotion };
  });

  // ==================== 可用模型（管理员后台维护） ====================
  app.get("/api/admin/models", { preHandler: [...admin] }, async () => ({
    models: await deps.modelService.listAll(),
  }));

  app.post<{ Body: Partial<ModelInput> }>("/api/admin/models", { preHandler: [...admin] }, async (req, reply) => {
    const b = req.body ?? {};
    const model = await deps.modelService.create({
      providerId: b.providerId ?? "",
      modelName: b.modelName ?? "",
      type: b.type ?? "text",
      displayName: b.displayName ?? "",
      enabled: b.enabled,
      sortOrder: b.sortOrder,
      tier: b.tier,
    });
    return reply.code(201).send({ model });
  });

  app.patch<{ Params: { id: string }; Body: Partial<ModelInput> }>(
    "/api/admin/models/:id",
    { preHandler: [...admin] },
    async (req) => {
      const model = await deps.modelService.update(req.params.id, req.body ?? {});
      return { model };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/models/:id",
    { preHandler: [...admin] },
    async (req) => {
      await deps.modelService.remove(req.params.id);
      return { ok: true };
    },
  );
}
