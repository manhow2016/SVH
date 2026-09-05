import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { users } from "./user";

/**
 * Workspace 元数据表（文档 §20：Workspace 必须属于用户）
 *
 * 原则：Database = Metadata，Filesystem = Project Artifacts。
 * 工作区内容（script.md、assets/ 等）只存在于文件系统，
 * 本表只保存 id / name / root_path / user_id 等元数据。
 *
 * user_id 为 NULL 表示历史遗留（无主）工作区，迁移时归属首个管理员。
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
