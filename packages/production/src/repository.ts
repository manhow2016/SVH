/**
 * Production 仓储 Port（文档 §6：领域只声明接口，不写 SQL）。
 *
 * drizzle/更细实现的适配层（Adapter）位于 server 模块
 * `apps/server/src/modules/production/repository.ts`。
 * 该接口只允许使用本包定义的领域类型，禁止引入数据库/HTTP 依赖。
 */
import type { ProductionProject } from "./project/project-types";
import type { ProductionScript } from "./script/script-types";
import type { Character } from "./character/character-types";
import type { ProductionScene } from "./scene/scene-types";
import type { Storyboard } from "./storyboard/storyboard-types";
import type { ProductionShot } from "./shot/shot-types";
import type { ProductionAsset, AssetType } from "./asset/asset-types";

/** 各实体的新记录类型（id/时间戳由仓储实现生成） */
export type NewProject = Omit<ProductionProject, "id" | "createdAt" | "updatedAt">;
export type NewScript = Omit<ProductionScript, "id" | "createdAt" | "updatedAt">;
export type NewCharacter = Omit<Character, "id" | "createdAt" | "updatedAt">;
export type NewScene = Omit<ProductionScene, "id" | "createdAt" | "updatedAt">;
export type NewStoryboard = Omit<Storyboard, "id" | "createdAt" | "updatedAt">;
export type NewShot = Omit<ProductionShot, "id" | "createdAt" | "updatedAt">;
export type NewAsset = Omit<ProductionAsset, "id" | "createdAt" | "updatedAt">;

/** 各实体的更新补丁（全量 Partial，Repository 负责写回 updatedAt） */
export type ProjectPatch = Partial<NewProject>;
export type ScriptPatch = Partial<NewScript>;
export type CharacterPatch = Partial<NewCharacter>;
export type ScenePatch = Partial<NewScene>;
export type StoryboardPatch = Partial<NewStoryboard>;
export type ShotPatch = Partial<NewShot>;

/** 工作区归属信息（用于推导冗余 user_id） */
export interface WorkspaceOwner {
  workspaceId: string;
  userId: string | null;
}

export interface ProductionRepository {
  // ---- 工作区归属 ----
  getWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwner | null>;

  // ---- Project ----
  createProject(data: NewProject): Promise<ProductionProject>;
  getProject(id: string): Promise<ProductionProject | null>;
  listProjects(workspaceId: string): Promise<ProductionProject[]>;
  updateProject(id: string, patch: ProjectPatch): Promise<ProductionProject>;

  // ---- Script ----
  createScript(data: NewScript): Promise<ProductionScript>;
  getScript(id: string): Promise<ProductionScript | null>;
  listScripts(projectId: string): Promise<ProductionScript[]>;
  updateScript(id: string, patch: ScriptPatch): Promise<ProductionScript>;

  // ---- Character ----
  createCharacter(data: NewCharacter): Promise<Character>;
  getCharacter(id: string): Promise<Character | null>;
  listCharacters(projectId: string): Promise<Character[]>;
  updateCharacter(id: string, patch: CharacterPatch): Promise<Character>;

  // ---- Scene ----
  createScene(data: NewScene): Promise<ProductionScene>;
  getScene(id: string): Promise<ProductionScene | null>;
  listScenes(projectId: string): Promise<ProductionScene[]>;
  updateScene(id: string, patch: ScenePatch): Promise<ProductionScene>;

  // ---- Storyboard ----
  createStoryboard(data: NewStoryboard): Promise<Storyboard>;
  getStoryboard(id: string): Promise<Storyboard | null>;
  listStoryboards(projectId: string): Promise<Storyboard[]>;
  listStoryboardsByScene(sceneId: string): Promise<Storyboard[]>;
  updateStoryboard(id: string, patch: StoryboardPatch): Promise<Storyboard>;

  // ---- Shot ----
  createShot(data: NewShot): Promise<ProductionShot>;
  getShot(id: string): Promise<ProductionShot | null>;
  listShots(projectId: string): Promise<ProductionShot[]>;
  listShotsByStoryboard(storyboardId: string): Promise<ProductionShot[]>;
  updateShot(id: string, patch: ShotPatch): Promise<ProductionShot>;

  // ---- Asset ----
  createAsset(data: NewAsset): Promise<ProductionAsset>;
  getAsset(id: string): Promise<ProductionAsset | null>;
  listAssets(projectId: string, type?: AssetType): Promise<ProductionAsset[]>;
  deleteAsset(id: string): Promise<void>;

  /** 跨实体原子操作（事务；实现需保证 fn 抛错时整体回滚） */
  transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T>;
}
