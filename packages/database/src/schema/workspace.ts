import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Workspace 元数据表
 *
 * 原则：Database = Metadata，Filesystem = Project Artifacts。
 * 工作区内容（script.md、assets/ 等）只存在于文件系统，
 * 本表只保存 id / name / root_path 等元数据。
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
