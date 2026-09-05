import type { FastifyInstance } from "fastify";
import type { MembershipService } from "../modules/membership/service";

export interface MembershipRouteDeps {
  membershipService: MembershipService;
}

/**
 * 会员 API（文档 §25）。
 *
 * GET /api/membership/current：当前会员（等级 / 订阅 / 功能权限）。
 * GET /api/membership/plans：可购买套餐（含活动价计算，Phase 6 追加）。
 */
export function registerMembershipRoutes(app: FastifyInstance, deps: MembershipRouteDeps): void {
  app.get("/api/membership/current", async (req) =>
    deps.membershipService.getCurrentMembership(req.user!.userId),
  );
}
