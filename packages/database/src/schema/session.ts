import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { workspaces } from "./workspace";

/**
 * Session 表
 *
 * status: idle | running | error
 * model_provider_id / model_id 记录该会话使用的模型配置。
 */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("新会话"),
  status: text("status").notNull().default("idle"),
  modelProviderId: text("model_provider_id").notNull().default("openai-compatible"),
  modelId: text("model_id").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
