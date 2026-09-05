import { and, desc, eq, gt, lt } from "drizzle-orm";
import {
  membershipFeatures,
  membershipTiers,
  tierFeatures,
  userSubscriptions,
  type SVHDatabase,
} from "@svh/database";
import { ERRORS } from "../../lib/errors";
import type { CurrentMembership, FeaturePermission, SubscriptionStatus, TierCode } from "./types";

const FREE_TIER_CODE = "free";

/**
 * 会员服务（文档 §17 apps/server/src/modules/membership/service.ts）。
 *
 * 核心接口：
 * - getCurrentMembership(userId)     当前会员（无有效订阅自动视为 free，§16）
 * - hasFeature / assertFeature       功能权限（后端权威校验，§19/§33）
 * - getFeatureConfig<T>              功能配置（如 maxWorkspaces，§21）
 *
 * 不与模型 Token / 费用产生任何关联（原则 1-4）。
 */
export class MembershipService {
  constructor(private readonly db: SVHDatabase) {}

  /** 当前会员（§15；无有效订阅 → free，§16；到期自动降级） */
  async getCurrentMembership(userId: string): Promise<CurrentMembership> {
    const now = new Date();

    // 惰性过期：将已到期的 active 订阅标记为 expired（到期自动降级 free）
    await this.db
      .update(userSubscriptions)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.status, "active"),
          lt(userSubscriptions.expiresAt, now),
        ),
      );

    // 当前有效订阅（取到期时间最晚的一条）
    const activeRows = await this.db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.status, "active"),
          gt(userSubscriptions.expiresAt, now),
        ),
      )
      .orderBy(desc(userSubscriptions.expiresAt))
      .limit(1);

    let tierId: string | null = null;
    let subscription: CurrentMembership["subscription"];
    if (activeRows[0]) {
      const sub = activeRows[0];
      const tier = await this.getEnabledTier(sub.tierId);
      if (tier) {
        tierId = tier.id;
        subscription = {
          id: sub.id,
          status: sub.status as SubscriptionStatus,
          startedAt: sub.startedAt.getTime(),
          expiresAt: sub.expiresAt.getTime(),
        };
      }
    }

    if (!tierId) {
      const free = await this.getTierByCode(FREE_TIER_CODE);
      tierId = free?.id ?? "tier_free";
    }

    const tier = (await this.getTierById(tierId)) ?? {
      id: tierId,
      code: FREE_TIER_CODE,
      name: "免费版",
      description: "",
      sortOrder: 0,
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    const features = await this.buildFeaturePermissions(tier.id);
    return {
      tier: { code: tier.code as TierCode, name: tier.name },
      ...(subscription ? { subscription } : {}),
      features,
    };
  }

  /** 功能权限断言（§17：没有权限抛 FEATURE_NOT_AVAILABLE，§40） */
  async assertFeature(userId: string, featureCode: string): Promise<void> {
    if (!(await this.hasFeature(userId, featureCode))) {
      throw ERRORS.FEATURE_NOT_AVAILABLE();
    }
  }

  /** 功能权限判断 */
  async hasFeature(userId: string, featureCode: string): Promise<boolean> {
    const membership = await this.getCurrentMembership(userId);
    return membership.features[featureCode]?.enabled === true;
  }

  /** 功能配置（§17；未启用或未配置返回 null） */
  async getFeatureConfig<T>(userId: string, featureCode: string): Promise<T | null> {
    const membership = await this.getCurrentMembership(userId);
    const permission = membership.features[featureCode];
    if (!permission?.enabled) return null;
    return (permission.config as T) ?? null;
  }

  /**
   * 资源限制（§21 软件资源限制，非 Token 限制）。
   * 从当前等级「已启用功能」的 config 中取第一个有效的数字限制，-1 = 不限制。
   */
  async getResourceLimit(userId: string, resource: "maxWorkspaces"): Promise<number | undefined> {
    const membership = await this.getCurrentMembership(userId);
    for (const permission of Object.values(membership.features)) {
      if (!permission.enabled || !permission.config) continue;
      const value = (permission.config as Record<string, unknown>)[resource];
      if (typeof value === "number") return value;
    }
    return undefined;
  }

  // ---- 内部 ----

  /** 等级全部功能权限（§8.2 config JSON 解析） */
  private async buildFeaturePermissions(tierId: string): Promise<Record<string, FeaturePermission>> {
    const links = await this.db.select().from(tierFeatures).where(eq(tierFeatures.tierId, tierId));
    const result: Record<string, FeaturePermission> = {};
    for (const link of links) {
      const code = await this.resolveFeatureCode(link.featureId);
      if (!code) continue;
      result[code] = {
        enabled: link.enabled,
        config: link.config ? (JSON.parse(link.config) as Record<string, unknown>) : null,
      };
    }
    return result;
  }

  private async resolveFeatureCode(featureId: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(membershipFeatures)
      .where(eq(membershipFeatures.id, featureId))
      .limit(1);
    return rows[0]?.code ?? null;
  }

  private async getTierByCode(code: string) {
    const rows = await this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.code, code))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getTierById(id: string) {
    const rows = await this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getEnabledTier(id: string) {
    const tier = await this.getTierById(id);
    return tier && tier.enabled ? tier : null;
  }
}
