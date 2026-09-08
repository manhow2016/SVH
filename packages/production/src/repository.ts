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
import type { ProductionEpisode } from "./episode/episode-types";
import type {
  GenerationKind,
  GenerationRecord,
  GenerationRecordStatus,
  GenerationReviewStatus,
} from "./generation/generation-record-types";
import type {
  ProductionTimeline,
  TimelineClip,
  TimelineTrack,
} from "./timeline/timeline-types";

/** 各实体的新记录类型（id/时间戳由仓储实现生成） */
export type NewProject = Omit<ProductionProject, "id" | "createdAt" | "updatedAt">;
export type NewEpisode = Omit<ProductionEpisode, "id" | "createdAt" | "updatedAt">;
export type NewScript = Omit<ProductionScript, "id" | "createdAt" | "updatedAt">;
export type NewCharacter = Omit<Character, "id" | "createdAt" | "updatedAt">;
export type NewScene = Omit<ProductionScene, "id" | "createdAt" | "updatedAt">;
export type NewStoryboard = Omit<Storyboard, "id" | "createdAt" | "updatedAt">;
export type NewShot = Omit<ProductionShot, "id" | "createdAt" | "updatedAt">;
export type NewAsset = Omit<ProductionAsset, "id" | "createdAt" | "updatedAt">;
export type NewGenerationRecord = Omit<GenerationRecord, "id" | "createdAt" | "updatedAt">;
export type NewTimeline = Omit<ProductionTimeline, "id" | "createdAt" | "updatedAt">;
export type NewTimelineTrack = Omit<TimelineTrack, "id" | "createdAt" | "updatedAt">;
export type NewTimelineClip = Omit<TimelineClip, "id" | "createdAt" | "updatedAt">;

/** 各实体的更新补丁（全量 Partial，Repository 负责写回 updatedAt） */
export type ProjectPatch = Partial<NewProject>;
export type EpisodePatch = Partial<NewEpisode>;
export type ScriptPatch = Partial<NewScript>;
export type CharacterPatch = Partial<NewCharacter>;
export type ScenePatch = Partial<NewScene>;
export type StoryboardPatch = Partial<NewStoryboard>;
export type ShotPatch = Partial<NewShot>;
export type GenerationRecordPatch = Partial<NewGenerationRecord>;
export type TimelinePatch = Partial<NewTimeline>;
export type TimelineTrackPatch = Partial<NewTimelineTrack>;
/** 剪辑更新补丁：关联列允许显式置空（null = 解除绑定，undefined = 不动） */
export type TimelineClipPatch = Partial<Omit<NewTimelineClip, "assetId" | "shotId">> & {
  assetId?: string | null;
  shotId?: string | null;
};

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

  // ---- Episode（短剧多集，V0.3） ----
  createEpisode(data: NewEpisode): Promise<ProductionEpisode>;
  getEpisode(id: string): Promise<ProductionEpisode | null>;
  listEpisodes(projectId: string): Promise<ProductionEpisode[]>;
  updateEpisode(id: string, patch: EpisodePatch): Promise<ProductionEpisode | null>;
  deleteEpisode(id: string): Promise<void>;

  // ---- Script ----
  createScript(data: NewScript): Promise<ProductionScript>;
  getScript(id: string): Promise<ProductionScript | null>;
  /** episodeId 可选：限定某集下的剧本（缺省返回项目全部） */
  listScripts(projectId: string, episodeId?: string): Promise<ProductionScript[]>;
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
  /** episodeId 可选：限定某集下的场景（缺省返回项目全部） */
  listScenes(projectId: string, episodeId?: string): Promise<ProductionScene[]>;
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
  /** episodeId 可选：经 scene → storyboard 链限定某集下的镜头（缺省返回项目全部） */
  listShots(projectId: string, episodeId?: string): Promise<ProductionShot[]>;
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
  /** 按任务 id 反查产物资产（generation.taskId 匹配；无则 null） */
  findAssetByTask(taskId: string): Promise<ProductionAsset | null>;

  // ---- Timeline（V0.3 Phase 2：成片时间轴 Project → Timeline → Track → Clip） ----
  createTimeline(data: NewTimeline): Promise<ProductionTimeline>;
  getTimeline(id: string): Promise<ProductionTimeline | null>;
  /** episodeId 可选：限定某集下的时间轴（缺省返回项目全部） */
  listTimelines(projectId: string, episodeId?: string): Promise<ProductionTimeline[]>;
  updateTimeline(id: string, patch: TimelinePatch): Promise<ProductionTimeline | null>;
  deleteTimeline(id: string): Promise<void>;

  createTimelineTrack(data: NewTimelineTrack): Promise<TimelineTrack>;
  getTimelineTrack(id: string): Promise<TimelineTrack | null>;
  listTimelineTracks(timelineId: string): Promise<TimelineTrack[]>;
  updateTimelineTrack(id: string, patch: TimelineTrackPatch): Promise<TimelineTrack | null>;
  deleteTimelineTrack(id: string): Promise<void>;

  createTimelineClip(data: NewTimelineClip): Promise<TimelineClip>;
  getTimelineClip(id: string): Promise<TimelineClip | null>;
  listTimelineClips(timelineId: string): Promise<TimelineClip[]>;
  listTimelineClipsByTrack(trackId: string): Promise<TimelineClip[]>;
  updateTimelineClip(id: string, patch: TimelineClipPatch): Promise<TimelineClip | null>;
  deleteTimelineClip(id: string): Promise<void>;

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

  /** 按任务 id 批量回写生成记录（worker 完成后标 completed + 挂产出资产） */
  updateGenerationRecordsByTask(
    taskId: string,
    patch: { status: GenerationRecordStatus; outputAssetId: string },
  ): Promise<void>;

  /** 跨实体原子操作（事务；实现需保证 fn 抛错时整体回滚） */
  transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T>;
}
