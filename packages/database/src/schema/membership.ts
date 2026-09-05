import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { membershipTiers, membershipFeatures } from "./membership-base";

export { membershipTiers, membershipFeatures };

/**
 * 会员等级 ↔ 功能 关联表（§8.2）
 *
 * config 使用 JSON 字符串保存功能配置，例如：
 * `{"maxWorkspaces": 3}`（-1 = 不限制）。
 */
export const tierFeatures = sqliteTable("tier_features", {
  id: text("id").primaryKey(),
  tierId: text("tier_id")
    .notNull()
    .references(() => membershipTiers.id, { onDelete: "cascade" }),
  featureId: text("feature_id")
    .notNull()
    .references(() => membershipFeatures.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  config: text("config").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type MembershipTierRow = typeof membershipTiers.$inferSelect;
export type NewMembershipTierRow = typeof membershipTiers.$inferInsert;
export type MembershipFeatureRow = typeof membershipFeatures.$inferSelect;
export type NewMembershipFeatureRow = typeof membershipFeatures.$inferInsert;
export type TierFeatureRow = typeof tierFeatures.$inferSelect;
export type NewTierFeatureRow = typeof tierFeatures.$inferInsert;
