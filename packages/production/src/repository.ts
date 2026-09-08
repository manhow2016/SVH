/**
 * Production 仓储 Port（文档 §6：领域只声明接口，不写 SQL）。
 *
 * drizzle 适配层见同包 `sqlite-repository.ts`（server 与 worker 共用）。
 * 该接口只允许使用本包定义的领域类型，禁止引入数据库/HTTP 依赖。
 */
import type { ProductionProject } from "./project/project-types";
import type { ProductionScript } from "./script/script-types";
import type { Character } from "./character/character-types";
import type { ProductionScene } from "./scene/scene-types";
import type { Storyboard } from "./storyboard/storyboard-types";
import type { ProductionShot } from "./shot/shot-types";
import type { ProductionAsset, AssetType } from "./asset/asset-types";
import type {
  GenerationKind,
  GenerationRecord,
  GenerationReviewStatus,
} from "./generation/generation-record-types";

/** 各实体的新记录类型（id/时间戳由仓储实现生成） */
export type NewProject = Omit<ProductionProject, "id" | "createdAt" | "updatedAt">;
export type NewScript = Omit<ProductionScript, "id" | "createdAt" | "updatedAt">;
export type NewCharacter = Omit<Character, "id" | "createdAt" | "updatedAt">;
export type NewScene = Omit<ProductionScene, "id" | "createdAt" | "updatedAt">;
export type NewStoryboard = Omit<Storyboard, "id" | "createdAt" | "updatedAt">;
export type NewShot = Omit<ProductionShot, "id" | "createdAt" | "updatedAt">;
export type NewAsset = Omit<ProductionAsset, "id" | "createdAt" | "updatedAt">;
export type NewGenerationRecord = Omit<GenerationRecord, "id" | "createdAt" | "updatedAt">;

/** 各实体的更新补丁（全量 Partial，Repository 负责写回 updatedAt） */
export type ProjectPatch = Partial<NewProject>;
export type ScriptPatch = Partial<NewScript>;
export type CharacterPatch = Partial<NewCharacter>;
export type ScenePatch = Partial<NewScene>;
export type StoryboardPatch = Partial<NewStoryboard>;
export type ShotPatch = Partial<NewShot>;
export type GenerationRecordPatch = Partial<NewGenerationRecord>;

/**
 * 资产窄更新补丁（本地化转存回写专用，设计文档 §4）。
 * 与全量 Patch 的区别：只允许碰转存需要回写的三列；
 * `null` = 显式清空该列，键缺省（undefined）= 不动该列（drizzle set 只带显式出现的键）。
 */
export interface AssetFieldsPatch {
  workspacePath?: string | null;
  metadata?: Record<string, unknown> | null;
  mimeType?: string | null;
}

/** 资产通用更新补丁（人工编辑名称/类型/URL/媒体类型；与窄更新 AssetFieldsPatch 区分） */
export type AssetPatch = Partial<Pick<NewAsset, "name" | "type" | "url" | "mimeType">>;

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
  deleteScript(id: string): Promise<void>;

  // ---- Character ----
  createCharacter(data: NewCharacter): Promise<Character>;
  getCharacter(id: string): Promise<Character | null>;
  listCharacters(projectId: string): Promise<Character[]>;
  updateCharacter(id: string, patch: CharacterPatch): Promise<Character>;
  deleteCharacter(id: string): Promise<void>;

  // ---- Scene ----
  createScene(data: NewScene): Promise<ProductionScene>;
  getScene(id: string): Promise<ProductionScene | null>;
  listScenes(projectId: string): Promise<ProductionScene[]>;
  updateScene(id: string, patch: ScenePatch): Promise<ProductionScene>;
  deleteScene(id: string): Promise<void>;

  // ---- Storyboard ----
  createStoryboard(data: NewStoryboard): Promise<Storyboard>;
  getStoryboard(id: string): Promise<Storyboard | null>;
  listStoryboards(projectId: string): Promise<Storyboard[]>;
  listStoryboardsByScene(sceneId: string): Promise<Storyboard[]>;
  updateStoryboard(id: string, patch: StoryboardPatch): Promise<Storyboard>;
  deleteStoryboard(id: string): Promise<void>;

  // ---- Shot ----
  createShot(data: NewShot): Promise<ProductionShot>;
  getShot(id: string): Promise<ProductionShot | null>;
  listShots(projectId: string): Promise<ProductionShot[]>;
  listShotsByStoryboard(storyboardId: string): Promise<ProductionShot[]>;
  updateShot(id: string, patch: ShotPatch): Promise<ProductionShot>;
  deleteShot(id: string): Promise<void>;

  // ---- Asset ----
  createAsset(data: NewAsset): Promise<ProductionAsset>;
  getAsset(id: string): Promise<ProductionAsset | null>;
  listAssets(projectId: string, type?: AssetType): Promise<ProductionAsset[]>;
  /** 窄更新：只写 patch 中出现的键（null 清列）并刷新 updatedAt；行不存在返回 null */
  updateAssetFields(id: string, patch: AssetFieldsPatch): Promise<ProductionAsset | null>;
  /** 通用更新（人工编辑名称/类型/URL/媒体类型）；行不存在返回 null */
  updateAsset(id: string, patch: AssetPatch): Promise<ProductionAsset | null>;
  deleteAsset(id: string): Promise<void>;

  // ---- Generation Record（V0.3 Phase 5：生成历史 + 审核） ----
  createGenerationRecord(data: NewGenerationRecord): Promise<GenerationRecord>;
  getGenerationRecord(id: string): Promise<GenerationRecord | null>;
  listGenerationRecords(
    projectId: string,
    filter?: {
      shotId?: string;
      storyboardId?: string;
      kind?: GenerationKind;
      reviewStatus?: GenerationReviewStatus;
    },
  ): Promise<GenerationRecord[]>;
  listGenerationRecordsByShot(shotId: string): Promise<GenerationRecord[]>;
  updateGenerationRecord(id: string, patch: GenerationRecordPatch): Promise<GenerationRecord | null>;

  /** 跨实体原子操作（事务；实现需保证 fn 抛错时整体回滚） */
  transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T>;
}
