import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
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

/** production_characters.visual_profile 的 JSON 结构（V0.3 Phase 3，与 @svh/production 同构） */
export interface CharacterVisualProfileJson {
  appearancePrompt?: string;
  identityPrompt?: string;
  costumePrompt?: string;
  stylePrompt?: string;
  negativePrompt?: string;
  referenceAssetIds?: string[];
}

/** production_assets.generation / metadata 的 JSON 结构（与 @svh/production 同构） */
export interface AssetGenerationJson {
  providerId: string;
  modelId?: string;
  prompt?: string;
  taskId?: string;
}

/** production_scenes/shots.visual_style 的 JSON 结构（V0.3 Phase 4，与 @svh/production 同构） */
export interface VisualStyleOverrideJson {
  styleName?: string;
  visualPrompt?: string;
  lighting?: string;
  colorTone?: string;
  cameraStyle?: string;
  renderingStyle?: string;
  negativePrompt?: string;
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

/**
 * 短剧多集（V0.3）：Project → Episode(1..n)。
 * 剧本/场景/时间轴挂集（episode_id）；角色与媒体资产跨集共享（挂项目）。
 */
export const productionEpisodes = sqliteTable("production_episodes", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  order: integer("sort_order").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionScripts = sqliteTable("production_scripts", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  /** V0.3 多集：所属集（NULL = 未挂集的历史数据） */
  episodeId: text("episode_id").references(() => productionEpisodes.id, { onDelete: "set null" }),
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
  /** V0.3 Phase 3：角色视觉档案（一致性） */
  visualProfile: text("visual_profile", { mode: "json" }).$type<CharacterVisualProfileJson>(),
  /** Phase C：配音音色（TTS 模型支持的 voice 名；缺省供应商默认） */
  voice: text("voice"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionScenes = sqliteTable("production_scenes", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  /** V0.3 多集：所属集 */
  episodeId: text("episode_id").references(() => productionEpisodes.id, { onDelete: "set null" }),
  scriptId: text("script_id"),
  order: integer("sort_order").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  location: text("location"),
  time: text("time"),
  characters: text("characters", { mode: "json" }).$type<string[]>().notNull(),
  /** V0.3 Phase 4：场景级视觉风格覆盖 */
  visualStyle: text("visual_style", { mode: "json" }).$type<VisualStyleOverrideJson>(),
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
  /** Phase C：镜头配音资产（TTS 产出；成片组装按镜头对齐） */
  audioAssetId: text("audio_asset_id"),
  status: text("status").notNull(),
  /** V0.3 Phase 4：镜头级视觉风格覆盖（优先级最高） */
  visualStyle: text("visual_style", { mode: "json" }).$type<VisualStyleOverrideJson>(),
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

/**
 * V0.3 Phase 5：生成记录（一次生成 = 一行，含提示词/参考/任务/产出/审核/版本）。
 * 与 production_tasks（执行）分离：本表专管生成历史与审核。
 */
export const generationRecords = sqliteTable("generation_records", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  shotId: text("shot_id"),
  storyboardId: text("storyboard_id"),
  kind: text("kind").notNull(),
  version: integer("version").notNull(),
  providerId: text("provider_id"),
  modelId: text("model_id"),
  prompt: text("prompt").notNull(),
  negativePrompt: text("negative_prompt"),
  promptMetadata: text("prompt_metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  inputRef: text("input_ref", { mode: "json" }).$type<{ imageUrl?: string }>(),
  taskId: text("task_id"),
  outputAssetId: text("output_asset_id"),
  status: text("status").notNull(),
  reviewStatus: text("review_status").notNull(),
  selected: integer("selected", { mode: "boolean" }).notNull().default(false),
  error: text("error"),
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
export type GenerationRecordRow = typeof generationRecords.$inferSelect;

/**
 * V0.3 Phase 2：成片时间轴（Project → Timeline → Track → Clip）。
 *
 * 领域模型见 @svh/production `timeline/`（本文件内联镜像，database 不依赖 production）。
 * 删除策略：Project 级联删 Timeline → Track → Clip；
 * Clip 关联的 Asset / Shot 被删除时解除绑定（SET NULL），不连坐时间轴。
 */
export const productionTimelines = sqliteTable("production_timelines", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => productionProjects.id, { onDelete: "cascade" }),
  /** V0.3 多集：所属集（成片按集） */
  episodeId: text("episode_id").references(() => productionEpisodes.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  /** 总时长（秒），由各轨 Clip 覆盖范围决定（领域层维护，默认 0） */
  duration: real("duration").notNull().default(0),
  fps: real("fps").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  status: text("status").notNull(),
  version: integer("version").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionTimelineTracks = sqliteTable("production_timeline_tracks", {
  id: text("id").primaryKey(),
  timelineId: text("timeline_id")
    .notNull()
    .references(() => productionTimelines.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  order: integer("sort_order").notNull(),
  muted: integer("muted", { mode: "boolean" }).notNull().default(false),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const productionTimelineClips = sqliteTable("production_timeline_clips", {
  id: text("id").primaryKey(),
  timelineId: text("timeline_id")
    .notNull()
    .references(() => productionTimelines.id, { onDelete: "cascade" }),
  trackId: text("track_id")
    .notNull()
    .references(() => productionTimelineTracks.id, { onDelete: "cascade" }),
  /** 关联生产资产；资产删除时解除绑定（SET NULL，保留剪辑位置） */
  assetId: text("asset_id").references(() => productionAssets.id, { onDelete: "set null" }),
  /** 关联镜头；镜头删除时解除绑定（SET NULL，保留剪辑位置） */
  shotId: text("shot_id").references(() => productionShots.id, { onDelete: "set null" }),
  startTime: real("start_time").notNull(),
  duration: real("duration").notNull(),
  sourceStartTime: real("source_start_time"),
  sourceDuration: real("source_duration"),
  order: integer("sort_order").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type ProductionTimelineRow = typeof productionTimelines.$inferSelect;
export type ProductionTimelineTrackRow = typeof productionTimelineTracks.$inferSelect;
export type ProductionTimelineClipRow = typeof productionTimelineClips.$inferSelect;

/** V0.3 多集：ProductionEpisode 行（Project → Episode(1..n)） */
export type ProductionEpisodeRow = typeof productionEpisodes.$inferSelect;
