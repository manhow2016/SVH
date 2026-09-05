import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { subscriptionPlans } from "./subscription";

/**
 * 活动与折扣表（§12.1）
 *
 * 折扣类型 discountType：
 * - `percentage`  百分比折扣（discountValue = 70 表示按原价 70% 支付）
 * - `fixed_amount` 固定金额减免（discountValue = 减免金额，单位：分）
 * - `fixed_price`  固定活动价（discountValue = 活动价格，单位：分）
 *
 * 金额全部使用整数（最小货币单位），禁止浮点。
 */
export const promotions = sqliteTable("promotions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  discountType: text("discount_type").notNull(),
  discountValue: integer("discount_value").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * 活动 ↔ 套餐 关联表（§13）
 *
 * 一个活动可关联多个套餐；一个套餐可属于多个活动，由 priority 控制优先级。
 */
export const promotionPlans = sqliteTable("promotion_plans", {
  id: text("id").primaryKey(),
  promotionId: text("promotion_id")
    .notNull()
    .references(() => promotions.id, { onDelete: "cascade" }),
  planId: text("plan_id")
    .notNull()
    .references(() => subscriptionPlans.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type PromotionRow = typeof promotions.$inferSelect;
export type NewPromotionRow = typeof promotions.$inferInsert;
export type PromotionPlanRow = typeof promotionPlans.$inferSelect;
export type NewPromotionPlanRow = typeof promotionPlans.$inferInsert;
