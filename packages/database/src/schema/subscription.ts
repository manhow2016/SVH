import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { membershipTiers } from "./membership-base";
import { users } from "./user";

/**
 * 订阅套餐表（§10.1）
 *
 * 价格统一保存最小货币单位（分），避免浮点问题。
 * 例如 30 元 → 3000。
 */
export const subscriptionPlans = sqliteTable("subscription_plans", {
  id: text("id").primaryKey(),
  tierId: text("tier_id")
    .notNull()
    .references(() => membershipTiers.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  durationDays: integer("duration_days").notNull(),
  originalPrice: integer("original_price").notNull(),
  currency: text("currency").notNull().default("CNY"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * 用户订阅表（§11.1）
 *
 * 必须保存购买时价格快照（original_price / discount_amount / paid_amount），
 * 禁止通过 plan → 当前价格追溯历史订单。
 *
 * 状态：pending | active | expired | cancelled
 */
export const userSubscriptions = sqliteTable("user_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  planId: text("plan_id")
    .notNull()
    .references(() => subscriptionPlans.id, { onDelete: "restrict" }),
  tierId: text("tier_id")
    .notNull()
    .references(() => membershipTiers.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("active"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  originalPrice: integer("original_price").notNull(),
  discountAmount: integer("discount_amount").notNull().default(0),
  paidAmount: integer("paid_amount").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SubscriptionPlanRow = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlanRow = typeof subscriptionPlans.$inferInsert;
export type UserSubscriptionRow = typeof userSubscriptions.$inferSelect;
export type NewUserSubscriptionRow = typeof userSubscriptions.$inferInsert;
