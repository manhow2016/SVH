import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { users } from "./user";
import { productionProjects } from "./production";

/**
 * 工作流与生产任务表（V0.2 文档 §17 / §15）。
 *
 * - workflows：工作流主表（状态 + 项目归属）
 * - workflow_nodes：节点过程状态持久化（status/retry/error/output 快照）
 * - production_tasks：异步生成任务（image/video/audio，Phase 7/8 使用）
 */

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const workflowNodes = sqliteTable("workflow_nodes", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  /** 逻辑节点 id（如 "script"），工作流内唯一 */
  nodeId: text("node_id").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  /** 创建顺序（保证 assemble 顺序稳定，与时间戳无关） */
  sortOrder: integer("sort_order").notNull().default(0),
  dependsOn: text("depends_on", { mode: "json" }).$type<string[]>().notNull(),
  input: text("input", { mode: "json" }),
  output: text("output", { mode: "json" }),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(0),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionTasks = sqliteTable("production_tasks", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
  /** 逻辑节点 id（来源节点） */
  nodeId: text("node_id"),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** 任务类型：image | video | audio | text */
  kind: text("kind").notNull(),
  /** 供应商 id（dashscope / volcengine / openai-compatible） */
  providerId: text("provider_id"),
  /** 供应商侧任务 id（异步轮询） */
  providerTaskId: text("provider_task_id"),
  /** 任务状态：queued | running | completed | failed | cancelled */
  status: text("status").notNull(),
  /** 进度 0-100 */
  progress: integer("progress"),
  outputUrl: text("output_url"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowNodeRow = typeof workflowNodes.$inferSelect;
export type ProductionTaskRow = typeof productionTasks.$inferSelect;
