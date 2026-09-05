import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * 用户表（文档 §6）
 *
 * - 角色 role：`user` | `admin`
 * - 状态 status：`active` | `disabled`
 * - 密码 password_hash 使用 Argon2 安全 Hash，禁止明文保存。
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
