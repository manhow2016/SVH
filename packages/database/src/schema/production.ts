import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { users } from "./user";
import { workspaces } from "./workspace";

/**
 * 生产领域数据表（V0.2 文档 §17）。
 *
 * 所有表关联 workspace_id 与 user_id：
 * - workspace_id：项目/资产的逻辑隔离边界（外键级联）
 * - user_id：冗余归属列（写入时从 workspace 行取值，便于隔离查询与未来团队协作）
 *
 * JSON 列使用 TEXT 存储 + drizzle mode:"json"（与 message.metadata 同款约定）；
 * 各 JSON 的结构类型在本文件内联镜像（database 不依赖 @svh/production，保持分层单向）。
 */

/** production_projects.settings 的 JSON 结构（与 @svh/production 同构） */
export interface ProductionProjectSettingsJson {
  duration?: number;
  style?: string;
  generation?: Record<string, unknown>;
}

/** production_characters.appearance 的 JSON 结构（与 @svh/production 同构） */
export interface CharacterAppearanceJson {
  gender?: string;
  age?: string;
  hairstyle?: string;
  clothing?: string;
  facialFeatures?: string;
  style?: string;
}

/** production_assets.generation / metadata 的 JSON 结构（与 @svh/production 同构） */
export interface AssetGenerationJson {
  providerId: string;
  modelId?: string;
  prompt?: string;
  taskId?: string;
}

export const productionProjects = sqliteTable("production_projects", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(),
  status: text("status").notNull(),
  settings: text("settings", { mode: "json" })
    .$type<ProductionProjectSettingsJson>()
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionScripts = sqliteTable("production_scripts", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionCharacters = sqliteTable("production_characters", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  appearance: text("appearance", { mode: "json" })
    .$type<CharacterAppearanceJson>()
    .notNull(),
  personality: text("personality"),
  referenceAssetId: text("reference_asset_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionScenes = sqliteTable("production_scenes", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  scriptId: text("script_id"),
  order: integer("sort_order").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  location: text("location"),
  time: text("time"),
  characters: text("characters", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionStoryboards = sqliteTable("production_storyboards", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  sceneId: text("scene_id")
    .notNull()
    .references(() => productionScenes.id, { onDelete: "cascade" }),
  order: integer("sort_order").notNull(),
  description: text("description").notNull(),
  duration: integer("duration").notNull(),
  shotType: text("shot_type").notNull(),
  cameraMovement: text("camera_movement"),
  imagePrompt: text("image_prompt"),
  videoPrompt: text("video_prompt"),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionShots = sqliteTable("production_shots", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  storyboardId: text("storyboard_id")
    .notNull()
    .references(() => productionStoryboards.id, { onDelete: "cascade" }),
  order: integer("sort_order").notNull(),
  duration: integer("duration").notNull(),
  framing: text("framing"),
  cameraMovement: text("camera_movement"),
  action: text("action"),
  dialogue: text("dialogue"),
  imageAssetId: text("image_asset_id"),
  videoAssetId: text("video_asset_id"),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionAssets = sqliteTable("production_assets", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  url: text("url"),
  workspacePath: text("workspace_path"),
  mimeType: text("mime_type"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  generation: text("generation", { mode: "json" }).$type<AssetGenerationJson>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type ProductionProjectRow = typeof productionProjects.$inferSelect;
export type ProductionScriptRow = typeof productionScripts.$inferSelect;
export type ProductionCharacterRow = typeof productionCharacters.$inferSelect;
export type ProductionSceneRow = typeof productionScenes.$inferSelect;
export type ProductionStoryboardRow = typeof productionStoryboards.$inferSelect;
export type ProductionShotRow = typeof productionShots.$inferSelect;
export type ProductionAssetRow = typeof productionAssets.$inferSelect;
