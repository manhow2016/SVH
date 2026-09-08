/**
 * Production 仓储适配层（drizzle + better-sqlite3 实现 @svh/production 的 Port）。
 *
 * drizzle 适配器与领域包同包维护（server 与 worker 共用）。本层是领域与数据库之间的 Adapter：
 * - 只做「行 ↔ 实体」映射与查询，不包含领域规则（规则在 ProductionService）
 * - JSON 列（settings/appearance/characters/metadata/generation）由 drizzle
 *   mode:"json" 自动序列化/反序列化
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { randomId } from "@svh/shared";
import type { SVHDatabase } from "@svh/database";
import {
  generationRecords,
  productionAssets,
  productionCharacters,
  productionProjects,
  productionScenes,
  productionScripts,
  productionShots,
  productionStoryboards,
  productionTimelineClips,
  productionTimelineTracks,
  productionTimelines,
  workspaces,
  type GenerationRecordRow,
  type ProductionAssetRow,
  type ProductionCharacterRow,
  type ProductionProjectRow,
  type ProductionSceneRow,
  type ProductionScriptRow,
  type ProductionShotRow,
  type ProductionStoryboardRow,
  type ProductionTimelineClipRow,
  type ProductionTimelineRow,
  type ProductionTimelineTrackRow,
} from "@svh/database";
import type { ProductionProject } from "./project/project-types";
import type { ProductionScript } from "./script/script-types";
import type { Character } from "./character/character-types";
import type { ProductionScene } from "./scene/scene-types";
import type { Storyboard } from "./storyboard/storyboard-types";
import type { ProductionShot } from "./shot/shot-types";
import type { ProductionAsset, AssetType } from "./asset/asset-types";
import type { GenerationKind, GenerationRecord, GenerationRecordStatus } from "./generation/generation-record-types";
import type {
  ProductionTimeline,
  TimelineClip,
  TimelineTrack,
} from "./timeline/timeline-types";
import type {
  NewAsset,
  NewCharacter,
  NewGenerationRecord,
  NewProject,
  NewScene,
  NewScript,
  NewShot,
  NewStoryboard,
  NewTimeline,
  NewTimelineClip,
  NewTimelineTrack,
  AssetFieldsPatch,
  AssetPatch,
  GenerationRecordPatch,
  ProductionRepository,
  ProjectPatch,
  ScenePatch,
  ScriptPatch,
  ShotPatch,
  StoryboardPatch,
  TimelineClipPatch,
  TimelinePatch,
  TimelineTrackPatch,
  WorkspaceOwner,
} from "./repository";

/** 行 → 领域实体（枚举/JSON/可空字段做显式映射：null → undefined） */
function toProject(row: ProductionProjectRow): ProductionProject {
  return {
    ...row,
    type: row.type as ProductionProject["type"],
    status: row.status as ProductionProject["status"],
    description: row.description ?? undefined,
    settings: row.settings as ProductionProject["settings"],
  };
}

function toTimeline(row: ProductionTimelineRow): ProductionTimeline {
  return {
    ...row,
    description: row.description ?? undefined,
    status: row.status as ProductionTimeline["status"],
  };
}

function toTimelineTrack(row: ProductionTimelineTrackRow): TimelineTrack {
  return {
    ...row,
    type: row.type as TimelineTrack["type"],
  };
}

function toTimelineClip(row: ProductionTimelineClipRow): TimelineClip {
  return {
    ...row,
    assetId: row.assetId ?? undefined,
    shotId: row.shotId ?? undefined,
    sourceStartTime: row.sourceStartTime ?? undefined,
    sourceDuration: row.sourceDuration ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

function toScript(row: ProductionScriptRow): ProductionScript {
  return { ...row, status: row.status as ProductionScript["status"] };
}

function toCharacter(row: ProductionCharacterRow): Character {
  return {
    ...row,
    appearance: row.appearance as Character["appearance"],
    personality: row.personality ?? undefined,
    referenceAssetId: row.referenceAssetId ?? undefined,
    visualProfile: row.visualProfile ?? undefined,
    voice: row.voice ?? undefined,
  };
}

function toScene(row: ProductionSceneRow): ProductionScene {
  return {
    ...row,
    scriptId: row.scriptId ?? undefined,
    location: row.location ?? undefined,
    time: row.time ?? undefined,
    characters: row.characters as ProductionScene["characters"],
    visualStyle: row.visualStyle ?? undefined,
  };
}

function toStoryboard(row: ProductionStoryboardRow): Storyboard {
  return {
    ...row,
    status: row.status as Storyboard["status"],
    cameraMovement: row.cameraMovement ?? undefined,
    imagePrompt: row.imagePrompt ?? undefined,
    videoPrompt: row.videoPrompt ?? undefined,
  };
}

function toShot(row: ProductionShotRow): ProductionShot {
  return {
    ...row,
    status: row.status as ProductionShot["status"],
    framing: row.framing ?? undefined,
    cameraMovement: row.cameraMovement ?? undefined,
    action: row.action ?? undefined,
    dialogue: row.dialogue ?? undefined,
    imageAssetId: row.imageAssetId ?? undefined,
    videoAssetId: row.videoAssetId ?? undefined,
    audioAssetId: row.audioAssetId ?? undefined,
    visualStyle: row.visualStyle ?? undefined,
  };
}

function toAsset(row: ProductionAssetRow): ProductionAsset {
  return {
    ...row,
    type: row.type as ProductionAsset["type"],
    url: row.url ?? undefined,
    workspacePath: row.workspacePath ?? undefined,
    mimeType: row.mimeType ?? undefined,
    metadata: row.metadata ?? undefined,
    generation: row.generation ?? undefined,
  };
}

function toGenerationRecord(row: GenerationRecordRow): GenerationRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    shotId: row.shotId ?? undefined,
    storyboardId: row.storyboardId ?? undefined,
    kind: row.kind as "image" | "video",
    version: row.version,
    providerId: row.providerId ?? undefined,
    modelId: row.modelId ?? undefined,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt ?? undefined,
    promptMetadata: row.promptMetadata ?? undefined,
    inputRef: row.inputRef ?? undefined,
    taskId: row.taskId ?? undefined,
    outputAssetId: row.outputAssetId ?? undefined,
    status: row.status as "queued" | "running" | "completed" | "failed" | "cancelled",
    reviewStatus: row.reviewStatus as
      | "pending"
      | "generating"
      | "generated"
      | "reviewing"
      | "approved"
      | "rejected"
      | "replaced",
    selected: row.selected,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleProductionRepository implements ProductionRepository {
  constructor(private readonly db: SVHDatabase) {}

  // ================= 工作区归属 =================

  async getWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwner | null> {
    const row = this.db
      .select({ workspaceId: workspaces.id, userId: workspaces.userId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get();
    if (!row) return null;
    return { workspaceId: row.workspaceId, userId: row.userId };
  }

  // ================= Project =================

  async createProject(data: NewProject): Promise<ProductionProject> {
    const row = this.db
      .insert(productionProjects)
      .values({ ...data, id: randomId("prj"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toProject(row);
  }

  async getProject(id: string): Promise<ProductionProject | null> {
    const row = this.db.select().from(productionProjects).where(eq(productionProjects.id, id)).get();
    return row ? toProject(row) : null;
  }

  async listProjects(workspaceId: string): Promise<ProductionProject[]> {
    return this.db
      .select()
      .from(productionProjects)
      .where(eq(productionProjects.workspaceId, workspaceId))
      .orderBy(asc(productionProjects.updatedAt), asc(productionProjects.id))
      .all()
      .map(toProject);
  }

  async updateProject(id: string, patch: ProjectPatch): Promise<ProductionProject> {
    const row = this.db
      .update(productionProjects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionProjects.id, id))
      .returning()
      .get();
    return toProject(row);
  }

  // ================= Script =================

  async createScript(data: NewScript): Promise<ProductionScript> {
    const row = this.db
      .insert(productionScripts)
      .values({ ...data, id: randomId("sct"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toScript(row);
  }

  async getScript(id: string): Promise<ProductionScript | null> {
    const row = this.db.select().from(productionScripts).where(eq(productionScripts.id, id)).get();
    return row ? toScript(row) : null;
  }

  async listScripts(projectId: string): Promise<ProductionScript[]> {
    return this.db
      .select()
      .from(productionScripts)
      .where(eq(productionScripts.projectId, projectId))
      .orderBy(asc(productionScripts.createdAt), asc(productionScripts.id))
      .all()
      .map(toScript);
  }

  async updateScript(id: string, patch: ScriptPatch): Promise<ProductionScript> {
    const row = this.db
      .update(productionScripts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionScripts.id, id))
      .returning()
      .get();
    return toScript(row);
  }

  async deleteScript(id: string): Promise<void> {
    this.db.delete(productionScripts).where(eq(productionScripts.id, id)).run();
  }

  // ================= Character =================

  async createCharacter(data: NewCharacter): Promise<Character> {
    const row = this.db
      .insert(productionCharacters)
      .values({ ...data, id: randomId("chr"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toCharacter(row);
  }

  async getCharacter(id: string): Promise<Character | null> {
    const row = this.db.select().from(productionCharacters).where(eq(productionCharacters.id, id)).get();
    return row ? toCharacter(row) : null;
  }

  async listCharacters(projectId: string): Promise<Character[]> {
    return this.db
      .select()
      .from(productionCharacters)
      .where(eq(productionCharacters.projectId, projectId))
      .orderBy(asc(productionCharacters.createdAt), asc(productionCharacters.id))
      .all()
      .map(toCharacter);
  }

  async updateCharacter(id: string, patch: Partial<NewCharacter>): Promise<Character> {
    const row = this.db
      .update(productionCharacters)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionCharacters.id, id))
      .returning()
      .get();
    return toCharacter(row);
  }

  async deleteCharacter(id: string): Promise<void> {
    this.db.delete(productionCharacters).where(eq(productionCharacters.id, id)).run();
  }

  // ================= Scene =================

  async createScene(data: NewScene): Promise<ProductionScene> {
    const row = this.db
      .insert(productionScenes)
      .values({ ...data, id: randomId("scn"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toScene(row);
  }

  async getScene(id: string): Promise<ProductionScene | null> {
    const row = this.db.select().from(productionScenes).where(eq(productionScenes.id, id)).get();
    return row ? toScene(row) : null;
  }

  async listScenes(projectId: string): Promise<ProductionScene[]> {
    return this.db
      .select()
      .from(productionScenes)
      .where(eq(productionScenes.projectId, projectId))
      .orderBy(asc(productionScenes.order), asc(productionScenes.id))
      .all()
      .map(toScene);
  }

  async updateScene(id: string, patch: ScenePatch): Promise<ProductionScene> {
    const row = this.db
      .update(productionScenes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionScenes.id, id))
      .returning()
      .get();
    return toScene(row);
  }

  async deleteScene(id: string): Promise<void> {
    this.db.delete(productionScenes).where(eq(productionScenes.id, id)).run();
  }

  // ================= Storyboard =================

  async createStoryboard(data: NewStoryboard): Promise<Storyboard> {
    const row = this.db
      .insert(productionStoryboards)
      .values({ ...data, id: randomId("sbd"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toStoryboard(row);
  }

  async getStoryboard(id: string): Promise<Storyboard | null> {
    const row = this.db.select().from(productionStoryboards).where(eq(productionStoryboards.id, id)).get();
    return row ? toStoryboard(row) : null;
  }

  async listStoryboards(projectId: string): Promise<Storyboard[]> {
    return this.db
      .select()
      .from(productionStoryboards)
      .where(eq(productionStoryboards.projectId, projectId))
      .orderBy(asc(productionStoryboards.order), asc(productionStoryboards.id))
      .all()
      .map(toStoryboard);
  }

  async listStoryboardsByScene(sceneId: string): Promise<Storyboard[]> {
    return this.db
      .select()
      .from(productionStoryboards)
      .where(eq(productionStoryboards.sceneId, sceneId))
      .orderBy(asc(productionStoryboards.order), asc(productionStoryboards.id))
      .all()
      .map(toStoryboard);
  }

  async updateStoryboard(id: string, patch: StoryboardPatch): Promise<Storyboard> {
    const row = this.db
      .update(productionStoryboards)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionStoryboards.id, id))
      .returning()
      .get();
    return toStoryboard(row);
  }

  async deleteStoryboard(id: string): Promise<void> {
    this.db.delete(productionStoryboards).where(eq(productionStoryboards.id, id)).run();
  }

  // ================= Shot =================

  async createShot(data: NewShot): Promise<ProductionShot> {
    const row = this.db
      .insert(productionShots)
      .values({ ...data, id: randomId("sht"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toShot(row);
  }

  async getShot(id: string): Promise<ProductionShot | null> {
    const row = this.db.select().from(productionShots).where(eq(productionShots.id, id)).get();
    return row ? toShot(row) : null;
  }

  async listShots(projectId: string): Promise<ProductionShot[]> {
    return this.db
      .select()
      .from(productionShots)
      .where(eq(productionShots.projectId, projectId))
      .all()
      .map(toShot);
  }

  async listShotsByStoryboard(storyboardId: string): Promise<ProductionShot[]> {
    return this.db
      .select()
      .from(productionShots)
      .where(eq(productionShots.storyboardId, storyboardId))
      .all()
      .map(toShot);
  }

  async updateShot(id: string, patch: ShotPatch): Promise<ProductionShot> {
    const row = this.db
      .update(productionShots)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionShots.id, id))
      .returning()
      .get();
    return toShot(row);
  }

  async deleteShot(id: string): Promise<void> {
    this.db.delete(productionShots).where(eq(productionShots.id, id)).run();
  }

  // ================= Asset =================

  async createAsset(data: NewAsset): Promise<ProductionAsset> {
    const row = this.db
      .insert(productionAssets)
      .values({ ...data, id: randomId("ast"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toAsset(row);
  }

  async getAsset(id: string): Promise<ProductionAsset | null> {
    const row = this.db.select().from(productionAssets).where(eq(productionAssets.id, id)).get();
    return row ? toAsset(row) : null;
  }

  async listAssets(projectId: string, type?: AssetType): Promise<ProductionAsset[]> {
    const where =
      type === undefined
        ? eq(productionAssets.projectId, projectId)
        : and(eq(productionAssets.projectId, projectId), eq(productionAssets.type, type));
    return this.db
      .select()
      .from(productionAssets)
      .where(where)
      .orderBy(asc(productionAssets.createdAt), asc(productionAssets.id))
      .all()
      .map(toAsset);
  }

  async updateAssetFields(id: string, patch: AssetFieldsPatch): Promise<ProductionAsset | null> {
    // 只带 patch 中出现的键（undefined 表示不动；null 由 drizzle 写成 SQL NULL）
    const set: Partial<typeof productionAssets.$inferInsert> = { updatedAt: new Date() };
    if (patch.workspacePath !== undefined) set.workspacePath = patch.workspacePath;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;
    if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
    const row = this.db
      .update(productionAssets)
      .set(set)
      .where(eq(productionAssets.id, id))
      .returning()
      .get();
    return row ? toAsset(row) : null;
  }

  async updateAsset(id: string, patch: AssetPatch): Promise<ProductionAsset | null> {
    // 只带 patch 中出现的键（undefined 表示不动；null 由 drizzle 写成 SQL NULL）
    const set: Partial<typeof productionAssets.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
    const row = this.db
      .update(productionAssets)
      .set(set)
      .where(eq(productionAssets.id, id))
      .returning()
      .get();
    return row ? toAsset(row) : null;
  }

  async deleteAsset(id: string): Promise<void> {
    this.db.delete(productionAssets).where(eq(productionAssets.id, id)).run();
  }

  async findAssetByTask(taskId: string): Promise<ProductionAsset | null> {
    const rows = this.db
      .select()
      .from(productionAssets)
      .where(sql`json_extract(${productionAssets.generation}, '$.taskId') = ${taskId}`)
      .orderBy(asc(productionAssets.createdAt), asc(productionAssets.id))
      .all();
    const row = rows[0];
    return row ? toAsset(row) : null;
  }

  // ================= Generation Record（V0.3 Phase 5） =================

  async createGenerationRecord(data: NewGenerationRecord): Promise<GenerationRecord> {
    const row = this.db
      .insert(generationRecords)
      .values({ ...data, id: randomId("gen"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toGenerationRecord(row);
  }

  async getGenerationRecord(id: string): Promise<GenerationRecord | null> {
    const row = this.db.select().from(generationRecords).where(eq(generationRecords.id, id)).get();
    return row ? toGenerationRecord(row) : null;
  }

  async listGenerationRecords(
    projectId: string,
    filter?: {
      shotId?: string;
      storyboardId?: string;
      kind?: GenerationKind;
      reviewStatus?: string;
    },
  ): Promise<GenerationRecord[]> {
    const conds = [eq(generationRecords.projectId, projectId)];
    if (filter?.shotId !== undefined) conds.push(eq(generationRecords.shotId, filter.shotId));
    if (filter?.storyboardId !== undefined) conds.push(eq(generationRecords.storyboardId, filter.storyboardId));
    if (filter?.kind !== undefined) conds.push(eq(generationRecords.kind, filter.kind));
    if (filter?.reviewStatus !== undefined) conds.push(eq(generationRecords.reviewStatus, filter.reviewStatus));
    return this.db
      .select()
      .from(generationRecords)
      .where(and(...conds))
      .orderBy(asc(generationRecords.createdAt), asc(generationRecords.id))
      .all()
      .map(toGenerationRecord);
  }

  async listGenerationRecordsByShot(shotId: string): Promise<GenerationRecord[]> {
    return this.db
      .select()
      .from(generationRecords)
      .where(eq(generationRecords.shotId, shotId))
      .orderBy(asc(generationRecords.version), asc(generationRecords.id))
      .all()
      .map(toGenerationRecord);
  }

  async updateGenerationRecord(
    id: string,
    patch: GenerationRecordPatch,
  ): Promise<GenerationRecord | null> {
    const row = this.db
      .update(generationRecords)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(generationRecords.id, id))
      .returning()
      .get();
    return row ? toGenerationRecord(row) : null;
  }

  async updateGenerationRecordsByTask(
    taskId: string,
    patch: { status: GenerationRecordStatus; outputAssetId: string },
  ): Promise<void> {
    this.db
      .update(generationRecords)
      .set({ status: patch.status, outputAssetId: patch.outputAssetId, updatedAt: new Date() })
      .where(eq(generationRecords.taskId, taskId))
      .run();
  }

  // ================= Timeline（V0.3 Phase 2：成片时间轴） =================

  async createTimeline(data: NewTimeline): Promise<ProductionTimeline> {
    const row = this.db
      .insert(productionTimelines)
      .values({ ...data, id: randomId("tml"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toTimeline(row);
  }

  async getTimeline(id: string): Promise<ProductionTimeline | null> {
    const row = this.db.select().from(productionTimelines).where(eq(productionTimelines.id, id)).get();
    return row ? toTimeline(row) : null;
  }

  async listTimelines(projectId: string): Promise<ProductionTimeline[]> {
    return this.db
      .select()
      .from(productionTimelines)
      .where(eq(productionTimelines.projectId, projectId))
      .orderBy(asc(productionTimelines.createdAt), asc(productionTimelines.id))
      .all()
      .map(toTimeline);
  }

  async updateTimeline(id: string, patch: TimelinePatch): Promise<ProductionTimeline | null> {
    const row = this.db
      .update(productionTimelines)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionTimelines.id, id))
      .returning()
      .get();
    return row ? toTimeline(row) : null;
  }

  async deleteTimeline(id: string): Promise<void> {
    this.db.delete(productionTimelines).where(eq(productionTimelines.id, id)).run();
  }

  // ---- Track ----

  async createTimelineTrack(data: NewTimelineTrack): Promise<TimelineTrack> {
    const row = this.db
      .insert(productionTimelineTracks)
      .values({ ...data, id: randomId("trk"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toTimelineTrack(row);
  }

  async getTimelineTrack(id: string): Promise<TimelineTrack | null> {
    const row = this.db.select().from(productionTimelineTracks).where(eq(productionTimelineTracks.id, id)).get();
    return row ? toTimelineTrack(row) : null;
  }

  async listTimelineTracks(timelineId: string): Promise<TimelineTrack[]> {
    return this.db
      .select()
      .from(productionTimelineTracks)
      .where(eq(productionTimelineTracks.timelineId, timelineId))
      .orderBy(asc(productionTimelineTracks.order), asc(productionTimelineTracks.id))
      .all()
      .map(toTimelineTrack);
  }

  async updateTimelineTrack(id: string, patch: TimelineTrackPatch): Promise<TimelineTrack | null> {
    const row = this.db
      .update(productionTimelineTracks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionTimelineTracks.id, id))
      .returning()
      .get();
    return row ? toTimelineTrack(row) : null;
  }

  async deleteTimelineTrack(id: string): Promise<void> {
    this.db.delete(productionTimelineTracks).where(eq(productionTimelineTracks.id, id)).run();
  }

  // ---- Clip ----

  async createTimelineClip(data: NewTimelineClip): Promise<TimelineClip> {
    const row = this.db
      .insert(productionTimelineClips)
      .values({ ...data, id: randomId("clp"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toTimelineClip(row);
  }

  async getTimelineClip(id: string): Promise<TimelineClip | null> {
    const row = this.db.select().from(productionTimelineClips).where(eq(productionTimelineClips.id, id)).get();
    return row ? toTimelineClip(row) : null;
  }

  async listTimelineClips(timelineId: string): Promise<TimelineClip[]> {
    return this.db
      .select()
      .from(productionTimelineClips)
      .where(eq(productionTimelineClips.timelineId, timelineId))
      .orderBy(asc(productionTimelineClips.startTime), asc(productionTimelineClips.order), asc(productionTimelineClips.id))
      .all()
      .map(toTimelineClip);
  }

  async listTimelineClipsByTrack(trackId: string): Promise<TimelineClip[]> {
    return this.db
      .select()
      .from(productionTimelineClips)
      .where(eq(productionTimelineClips.trackId, trackId))
      .orderBy(asc(productionTimelineClips.order), asc(productionTimelineClips.id))
      .all()
      .map(toTimelineClip);
  }

  async updateTimelineClip(id: string, patch: TimelineClipPatch): Promise<TimelineClip | null> {
    const row = this.db
      .update(productionTimelineClips)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionTimelineClips.id, id))
      .returning()
      .get();
    return row ? toTimelineClip(row) : null;
  }

  async deleteTimelineClip(id: string): Promise<void> {
    this.db.delete(productionTimelineClips).where(eq(productionTimelineClips.id, id)).run();
  }

  // ================= 事务 =================

  async transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T> {
    // 说明：drizzle better-sqlite3 的事务回调只支持同步（不会 await async 回调），
    // 因此使用底层连接手动 BEGIN/COMMIT/ROLLBACK，保证 async 事务语义正确。
    const sqlite = this.db.$client;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(new DrizzleProductionRepository(this.db));
      sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}
