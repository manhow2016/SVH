import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sessions } from "./session";

/**
 * 消息表
 *
 * role: system | user | assistant | tool
 * metadata 使用 JSON 保存：
 *  - assistant 消息: { toolCalls?: { id, name, arguments }[] }
 *  - tool 消息:      { toolName, input, output, error? }
 */
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["system", "user", "assistant", "tool"] }).notNull(),
  content: text("content").notNull().default(""),
  toolCallId: text("tool_call_id"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

/** 消息 metadata 的 TypeScript 结构 */
export interface ToolMessageMetadata {
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: boolean;
}

export interface MessageMetadata extends ToolMessageMetadata {
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  error?: boolean;
}
