import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import {
  promotions,
  promotionPlans,
  subscriptionPlans,
  type SVHDatabase,
  type PromotionRow,
} from "@svh/database";
import { randomId } from "@svh/shared";
import { ERRORS } from "../../lib/errors";
import type { ActivePromotion, PriceCalculator, PriceResult } from "./types";

/** 活动展示结构（管理端） */
export interface PromotionView {
  id: string;
  name: string;
  description: string;
  discountType: string;
  discountValue: number;
  startedAt: number;
  endedAt: number | null;
  enabled: boolean;
  priority: number;
  planIds: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 活动与折扣服务（文档 §12-§14，PromotionService）。
 *
 * - getBestPromotion(planId)：当前有效活动按 priority 取最高
 * - calculatePrice(planId)：整数金额计算（分），禁止浮点（§12.2）
 * - 与套餐通过 promotion_plans 关联（§13）
 */
export class PromotionService implements PriceCalculator {
  constructor(private readonly db: SVHDatabase) {}

  // ---- 价格计算（§14） ----

  /** 当前有效活动（enabled + 时间窗 + priority 降序），无则 null */
  async getBestPromotion(planId: string): Promise<ActivePromotion | null> {
    const now = new Date();
    const rows = await this.db
      .select({ promotion: promotions })
      .from(promotionPlans)
      .innerJoin(promotions, eq(promotions.id, promotionPlans.promotionId))
      .where(
        and(
          eq(promotionPlans.planId, planId),
          eq(promotions.enabled, true),
          lte(promotions.startedAt, now),
          or(isNull(promotions.endedAt), gte(promotions.endedAt, now)),
        ),
      )
      .orderBy(desc(promotions.priority))
      .limit(1);
    const p = rows[0]?.promotion;
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      discountType: p.discountType as ActivePromotion["discountType"],
      discountValue: p.discountValue,
      priority: p.priority,
    };
  }

  /** 价格计算（§12/§14）：返回原价 / 优惠金额 / 最终价（单位：分，整数运算） */
  async calculatePrice(planId: string): Promise<PriceResult> {
    const plans = await this.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);
    const plan = plans[0];
    if (!plan) throw ERRORS.PLAN_NOT_AVAILABLE();

    const original = plan.originalPrice;
    const promotion = await this.getBestPromotion(planId);
    if (!promotion) {
      return { originalPrice: original, discountAmount: 0, finalPrice: original };
    }

    switch (promotion.discountType) {
      case "percentage": {
        // 文档 §12.2：finalPrice = floor(original * value / 100)，整数运算
        const finalPrice = Math.floor((original * promotion.discountValue) / 100);
        return {
          originalPrice: original,
          discountAmount: original - finalPrice,
          finalPrice,
          promotionId: promotion.id,
        };
      }
      case "fixed_amount": {
        // 文档 §12.3：固定减免金额（分）
        const discountAmount = Math.min(promotion.discountValue, original);
        return {
          originalPrice: original,
          discountAmount,
          finalPrice: original - discountAmount,
          promotionId: promotion.id,
        };
      }
      case "fixed_price": {
        // 文档 §12.4：固定活动价
        const finalPrice = Math.min(promotion.discountValue, original);
        return {
          originalPrice: original,
          discountAmount: original - finalPrice,
          finalPrice,
          promotionId: promotion.id,
        };
      }
      default:
        throw ERRORS.INVALID_INPUT(`不支持的折扣类型：${promotion.discountType}`);
    }
  }

  // ---- 管理端 CRUD（§26） ----

  async listAll(): Promise<PromotionView[]> {
    const rows = await this.db.select().from(promotions).orderBy(desc(promotions.priority));
    const result = [];
    for (const row of rows) {
      result.push(await this.toView(row));
    }
    return result;
  }

  async create(input: {
    name: string;
    description?: string;
    discountType: string;
    discountValue: number;
    startedAt?: number;
    endedAt?: number | null;
    enabled?: boolean;
    priority?: number;
    planIds?: string[];
  }): Promise<PromotionView> {
    const name = input.name?.trim();
    if (!name) throw ERRORS.INVALID_INPUT("name is required");
    if (!["percentage", "fixed_amount", "fixed_price"].includes(input.discountType)) {
      throw ERRORS.INVALID_INPUT("discountType 只能是 percentage / fixed_amount / fixed_price");
    }
    if (!Number.isInteger(input.discountValue) || input.discountValue < 0) {
      throw ERRORS.INVALID_INPUT("discountValue 必须为非负整数");
    }
    const now = new Date();
    const id = randomId("promo");
    await this.db.insert(promotions).values({
      id,
      name,
      description: input.description ?? "",
      discountType: input.discountType,
      discountValue: input.discountValue,
      startedAt: input.startedAt ? new Date(input.startedAt) : now,
      endedAt: input.endedAt ? new Date(input.endedAt) : null,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
      createdAt: now,
      updatedAt: now,
    });
    await this.setPlanIds(id, input.planIds ?? []);
    return (await this.getView(id))!;
  }

  async update(
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      discountType: string;
      discountValue: number;
      startedAt: number;
      endedAt: number | null;
      enabled: boolean;
      priority: number;
      planIds: string[];
    }>,
  ): Promise<PromotionView> {
    const existing = await this.getView(id);
    if (!existing) throw ERRORS.PROMOTION_NOT_AVAILABLE();
    const now = new Date();
    const set: Partial<PromotionRow> = {
      name: patch.name?.trim() || existing.name,
      description: patch.description ?? existing.description,
      discountType: patch.discountType ?? existing.discountType,
      discountValue: patch.discountValue ?? existing.discountValue,
      startedAt: patch.startedAt ? new Date(patch.startedAt) : new Date(existing.startedAt),
      endedAt:
        patch.endedAt === undefined
          ? existing.endedAt
            ? new Date(existing.endedAt)
            : null
          : patch.endedAt
            ? new Date(patch.endedAt)
            : null,
      enabled: patch.enabled ?? existing.enabled,
      priority: patch.priority ?? existing.priority,
      updatedAt: now,
    };
    await this.db.update(promotions).set(set).where(eq(promotions.id, id));
    if (patch.planIds) await this.setPlanIds(id, patch.planIds);
    return (await this.getView(id))!;
  }

  // ---- 内部 ----

  private async setPlanIds(promotionId: string, planIds: string[]): Promise<void> {
    await this.db.delete(promotionPlans).where(eq(promotionPlans.promotionId, promotionId));
    const now = new Date();
    for (const planId of planIds) {
      const plan = await this.db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .limit(1);
      if (!plan[0]) continue;
      await this.db.insert(promotionPlans).values({
        id: randomId("pp"),
        promotionId,
        planId,
        createdAt: now,
      });
    }
  }

  private async toView(row: PromotionRow): Promise<PromotionView> {
    const links = await this.db
      .select()
      .from(promotionPlans)
      .where(eq(promotionPlans.promotionId, row.id));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      discountType: row.discountType,
      discountValue: row.discountValue,
      startedAt: row.startedAt.getTime(),
      endedAt: row.endedAt ? row.endedAt.getTime() : null,
      enabled: row.enabled,
      priority: row.priority,
      planIds: links.map((l) => l.planId),
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }

  private async getView(id: string): Promise<PromotionView | null> {
    const rows = await this.db.select().from(promotions).where(eq(promotions.id, id)).limit(1);
    return rows[0] ? this.toView(rows[0]) : null;
  }
}
