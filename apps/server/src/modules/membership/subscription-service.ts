import { and, desc, eq, gt } from "drizzle-orm";
import {
  membershipTiers,
  subscriptionPlans,
  users as usersTable,
  userSubscriptions,
  type SVHDatabase,
  type SubscriptionPlanRow,
  type UserSubscriptionRow,
} from "@svh/database";
import { randomId } from "@svh/shared";
import { ERRORS } from "../../lib/errors";
import type { PriceCalculator, PriceResult } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 订阅视图（时间戳 ms + 名称冗余，便于前端直接渲染） */
export interface UserSubscriptionView {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  tierId: string;
  tierName: string;
  tierCode: string;
  status: "pending" | "active" | "expired" | "cancelled";
  startedAt: number;
  expiresAt: number;
  originalPrice: number;
  discountAmount: number;
  paidAmount: number;
  createdAt: number;
  updatedAt: number;
}

/** 无活动时的默认价格计算（Phase 5 过渡；Phase 6 由 PromotionService 替换） */
export class DefaultPriceCalculator implements PriceCalculator {
  constructor(private readonly db: SVHDatabase) {}
  async calculatePrice(planId: string): Promise<PriceResult> {
    const plan = await this.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);
    if (!plan[0]) throw ERRORS.PLAN_NOT_AVAILABLE();
    return {
      originalPrice: plan[0].originalPrice,
      discountAmount: 0,
      finalPrice: plan[0].originalPrice,
    };
  }
}

/** 套餐创建输入 */
export interface CreatePlanInput {
  tierId?: string;
  tierCode?: string;
  name: string;
  description?: string;
  durationDays: number;
  originalPrice: number;
  currency?: string;
  enabled?: boolean;
  sortOrder?: number;
}

/**
 * 订阅套餐服务（§10/§11）。
 *
 * 价格不硬编码（原则 9）：套餐价格 / 天数 / 上下架全部由管理员配置；
 * 用户订阅必须保存购买时价格快照（§11.2），禁止通过 plan 当前价格追溯历史。
 */
export class SubscriptionPlanService {
  constructor(
    private readonly db: SVHDatabase,
    private readonly priceCalculator: PriceCalculator,
  ) {}

  /** 可购买套餐（§25）：启用套餐 + 活动价计算 */
  async listEnabled(): Promise<
    Array<SubscriptionPlanRow & { price: PriceResult; tier: { code: string; name: string } }>
  > {
    const rows = await this.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.enabled, true))
      .orderBy(subscriptionPlans.sortOrder);
    const result = [];
    for (const plan of rows) {
      const tier = await this.getTier(plan.tierId);
      result.push({
        ...plan,
        tier: { code: tier?.code ?? plan.tierId, name: tier?.name ?? plan.tierId },
        price: await this.priceCalculator.calculatePrice(plan.id),
      });
    }
    return result;
  }

  /** 管理员：全部套餐（含下架） */
  async listAll(): Promise<Array<SubscriptionPlanRow & { tier: { code: string; name: string } }>> {
    const rows = await this.db
      .select()
      .from(subscriptionPlans)
      .orderBy(subscriptionPlans.sortOrder);
    const result = [];
    for (const plan of rows) {
      const tier = await this.getTier(plan.tierId);
      result.push({
        ...plan,
        tier: { code: tier?.code ?? plan.tierId, name: tier?.name ?? plan.tierId },
      });
    }
    return result;
  }

  async get(planId: string): Promise<SubscriptionPlanRow | null> {
    const rows = await this.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 创建（tierId 或 tierCode 二选一） */
  async create(input: CreatePlanInput): Promise<SubscriptionPlanRow> {
    const name = input.name?.trim();
    if (!name) throw ERRORS.INVALID_INPUT("name is required");
    if (!Number.isInteger(input.durationDays) || input.durationDays <= 0) {
      throw ERRORS.INVALID_INPUT("durationDays 必须为正整数");
    }
    if (!Number.isInteger(input.originalPrice) || input.originalPrice < 0) {
      throw ERRORS.INVALID_INPUT("originalPrice 必须为非负整数（单位：分）");
    }
    let tierId = input.tierId;
    if (!tierId && input.tierCode) {
      const tier = await this.db
        .select()
        .from(membershipTiers)
        .where(eq(membershipTiers.code, input.tierCode))
        .limit(1);
      tierId = tier[0]?.id;
    }
    if (!tierId || !(await this.getTier(tierId))) {
      throw ERRORS.INVALID_INPUT("tierId / tierCode 无效");
    }
    const now = new Date();
    const rows = await this.db
      .insert(subscriptionPlans)
      .values({
        id: randomId("plan"),
        tierId,
        name,
        description: input.description ?? "",
        durationDays: input.durationDays,
        originalPrice: input.originalPrice,
        currency: input.currency ?? "CNY",
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rows[0]!;
  }

  /** 更新（名称/描述/天数/价格/上下架/排序） */
  async update(
    planId: string,
    patch: Partial<
      Pick<SubscriptionPlanRow, "name" | "description" | "durationDays" | "originalPrice" | "currency" | "enabled" | "sortOrder">
    >,
  ): Promise<SubscriptionPlanRow> {
    if (!(await this.get(planId))) throw ERRORS.PLAN_NOT_AVAILABLE();
    await this.db
      .update(subscriptionPlans)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, planId));
    return (await this.get(planId))!;
  }

  private getTier(tierId: string) {
    return this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, tierId))
      .limit(1)
      .then((r) => r[0] ?? null);
  }
}

/**
 * 订阅服务（§11/§27/§28）：
 * - grant（管理员手动开通，V1 无支付系统）
 * - 续费规则：未过期 → 在当前到期时间上顺延；已过期 → 从当前时间起算
 * - 价格快照：original_price / discount_amount / paid_amount
 */
export class SubscriptionService {
  constructor(
    private readonly db: SVHDatabase,
    private readonly planService: SubscriptionPlanService,
    private readonly priceCalculator: PriceCalculator,
  ) {}

  /** 管理员手动开通会员（§27 POST /api/admin/subscriptions/grant） */
  async grant(userId: string, planId: string): Promise<{
    subscription: UserSubscriptionView;
    price: PriceResult;
  }> {
    const plan = await this.planService.get(planId);
    if (!plan || !plan.enabled) throw ERRORS.PLAN_NOT_AVAILABLE();

    // 当前有效订阅（开通前取到期时间，用于续费顺延，§28）
    const now = new Date();
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
    const currentExpiry = activeRows[0]?.expiresAt ?? null;

    // 旧有效订阅标记为 cancelled（同一时刻仅存在一条有效订阅）
    await this.db
      .update(userSubscriptions)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.status, "active"),
        ),
      );

    // 价格快照：购买时价格 → 活动价（§11.2）
    const price = await this.priceCalculator.calculatePrice(planId);

    const base = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
    const expiresAt = new Date(base.getTime() + plan.durationDays * DAY_MS);

    const id = randomId("sub");
    await this.db.insert(userSubscriptions).values({
      id,
      userId,
      planId,
      tierId: plan.tierId,
      status: "active",
      startedAt: now,
      expiresAt,
      originalPrice: price.originalPrice,
      discountAmount: price.discountAmount,
      paidAmount: price.finalPrice,
      createdAt: now,
      updatedAt: now,
    });

    return { subscription: (await this.getById(id))!, price };
  }

  /** 用户的订阅记录（倒序） */
  async listForUser(userId: string): Promise<UserSubscriptionView[]> {
    const rows = await this.db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .orderBy(desc(userSubscriptions.createdAt));
    return Promise.all(rows.map((r) => this.toView(r)));
  }

  /** 管理员：全部订阅（含用户与套餐信息） */
  async listAll(): Promise<Array<UserSubscriptionView & { username?: string }>> {
    const rows = await this.db
      .select()
      .from(userSubscriptions)
      .orderBy(desc(userSubscriptions.createdAt));
    const result = [];
    for (const row of rows) {
      const view = await this.toView(row);
      const user = await this.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, row.userId))
        .limit(1);
      result.push({ ...view, username: user[0]?.username });
    }
    return result;
  }

  private async getById(id: string): Promise<UserSubscriptionView | null> {
    const rows = await this.db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, id))
      .limit(1);
    return rows[0] ? this.toView(rows[0]) : null;
  }

  private async toView(row: UserSubscriptionRow): Promise<UserSubscriptionView> {
    const tier = await this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, row.tierId))
      .limit(1);
    const plan = await this.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, row.planId))
      .limit(1);
    return {
      id: row.id,
      userId: row.userId,
      planId: row.planId,
      planName: plan[0]?.name ?? row.planId,
      tierId: row.tierId,
      tierName: tier[0]?.name ?? row.tierId,
      tierCode: tier[0]?.code ?? row.tierId,
      status: row.status as "pending" | "active" | "expired" | "cancelled",
      startedAt: row.startedAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      originalPrice: row.originalPrice,
      discountAmount: row.discountAmount,
      paidAmount: row.paidAmount,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }
}
