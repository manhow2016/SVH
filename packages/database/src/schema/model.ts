import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * 可用模型表（管理员在后台维护，用户视角只读）。
 *
 * 模型属供应商（火山引擎 / 阿里云百炼），字段：
 * - provider_id：供应商 id（对应 model-catalog MODEL_PROVIDERS）
 * - model_name：供应商侧模型名（API 调用使用，如 doubao-seed-1-6-250615）
 * - type：模型类型（text / image / video / audio）
 * - display_name：显示名称（前端展示，如 豆包 Seed 1.6）
 * - enabled：是否可用（停用后用户不可见、不可调用）
 * - tier：生成方案档位（economy 最省钱 / balanced 均衡 / quality 高质量；
 *   用户选择方案后由系统按档位自动挑选模型，无需用户选模型）
 */
export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelName: text("model_name").notNull(),
  type: text("type").notNull(),
  displayName: text("display_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  tier: text("tier").notNull().default("balanced"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type ModelRow = typeof models.$inferSelect;
export type NewModelRow = typeof models.$inferInsert;
