import type { FastifyInstance } from "fastify";
import type { MembershipService } from "../modules/membership/service";
import type { SubscriptionPlanService } from "../modules/membership/subscription-service";

export interface MembershipRouteDeps {
  membershipService: MembershipService;
  planService: SubscriptionPlanService;
}

/**
 * 会员 API（文档 §25）。
 *
 * GET /api/membership/current：当前会员（等级 / 订阅 / 功能权限）。
 * GET /api/membership/plans：可购买套餐（原价 / 活动优惠 / 最终价格，§25）。
 */
export function registerMembershipRoutes(app: FastifyInstance, deps: MembershipRouteDeps): void {
  app.get("/api/membership/current", async (req) =>
    deps.membershipService.getCurrentMembership(req.user!.userId),
  );

  app.get("/api/membership/plans", async () => ({
    plans: await deps.planService.listEnabled(),
  }));
}
