import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * 会员等级表（§7）
 *
 * 默认初始化：free / pro / enterprise（免费版 / 专业版 / 企业版）。
 * 价格不在此表，价格存于 subscription_plans（管理员可配置）。
 */
export const membershipTiers = sqliteTable("membership_tiers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * 功能表（§8.1）
 */
export const membershipFeatures = sqliteTable("membership_features", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
