import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { workspaces } from "./workspace";
import { productionProjects } from "./production";

/**
 * Session 表
 *
 * status: idle | running | error
 * model_provider_id / model_id 记录该会话使用的模型配置。
 * project_id: 会话与生产项目一对一绑定（项目创建时自动建会话，用户不可新建；
 *            NULL 仅存在于历史孤儿会话，不再出现在 UI）。
 */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => productionProjects.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("新会话"),
  status: text("status").notNull().default("idle"),
  modelProviderId: text("model_provider_id").notNull().default("openai-compatible"),
  modelId: text("model_id").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
