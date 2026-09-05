import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Settings 表（V1 预留长期持久化结构）
 *
 * V1 默认使用环境变量（SVH_LLM_BASE_URL / SVH_LLM_API_KEY / SVH_LLM_MODEL），
 * 本表用于保存用户在 Settings 页面修改过的配置（服务端存储，ApiKey 不直出）。
 * value 为 JSON 字符串。
 *
 * user_id 区分用户级配置（文档 §37 数据隔离）：NULL 表示全局默认行（兼容旧数据）。
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  userId: text("user_id"),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
