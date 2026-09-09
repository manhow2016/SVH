/**
 * 内存版 ProductionRepository 假实现（仅测试用）。
 *
 * 模拟 server 层 drizzle 仓储的语义：按 id 存内存 Map、
 * 创建时生成 id、更新时刷新 updatedAt、删除/查询按条件过滤。
 */
import { randomId } from "@svh/shared";
import type {
  Character,
  NewCharacter,
  NewEpisode,
  EpisodePatch,
  ProductionEpisode,
  CharacterPatch,
  AssetFieldsPatch,
  AssetPatch,
  NewProject,
  ProductionProject,
  ProjectPatch,
  ProductionScript,
  NewScript,
  ScriptPatch,
  ProductionScene,
  NewScene,
  ScenePatch,
  Storyboard,
  NewStoryboard,
  StoryboardPatch,
  ProductionShot,
  NewShot,
  ShotPatch,
  ProductionAsset,
  NewAsset,
  AssetType,
  AssetLibraryRefView,
  NewAssetLibraryRef,
  ProductionRepository,
  WorkspaceOwner,
  NewGenerationRecord,
  GenerationRecord,
  GenerationRecordStatus,
  GenerationRecordPatch,
  GenerationKind,
  GenerationReviewStatus,
  NewTimeline,
  ProductionTimeline,
  TimelinePatch,
  NewTimelineTrack,
  TimelineTrack,
  TimelineTrackPatch,
  NewTimelineClip,
  TimelineClip,
  TimelineClipPatch,
} from "../../src/index";

function now(): Date {
  return new Date();
}

export class FakeProductionRepository implements ProductionRepository {
  private owners = new Map<string, WorkspaceOwner>();
  private projects = new Map<string, ProductionProject>();
  private episodes = new Map<string, ProductionEpisode>();
  private scripts = new Map<string, ProductionScript>();
  private characters = new Map<string, Character>();
  private scenes = new Map<string, ProductionScene>();
  private storyboards = new Map<string, Storyboard>();
  private shots = new Map<string, ProductionShot>();
  private assets = new Map<string, ProductionAsset>();
  /** 资产库引用（种子化 key = "assetId:libPath"） */
  private libraryRefs = new Map<string, { id: string; projectId: string; assetId: string; libPath: string; createdAt: Date }>();
  private generationRecords = new Map<string, GenerationRecord>();
  private timelines = new Map<string, ProductionTimeline>();
  private timelineTracks = new Map<string, TimelineTrack>();
  private timelineClips = new Map<string, TimelineClip>();

  // ---- 测试辅助：直接注入工作区归属 ----
  seedOwner(workspaceId: string, userId: string | null): void {
    this.owners.set(workspaceId, { workspaceId, userId });
  }

  async getWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwner | null> {
    return this.owners.get(workspaceId) ?? null;
  }

  async createProject(data: NewProject): Promise<ProductionProject> {
    const entity: ProductionProject = { ...data, id: randomId("prj"), createdAt: now(), updatedAt: now() };
    this.projects.set(entity.id, entity);
    return entity;
  }

  async getProject(id: string): Promise<ProductionProject | null> {
    return this.projects.get(id) ?? null;
  }

  async listProjects(workspaceId: string): Promise<ProductionProject[]> {
    return [...this.projects.values()].filter((p) => p.workspaceId === workspaceId);
  }

  async updateProject(id: string, patch: ProjectPatch): Promise<ProductionProject> {
    const current = this.requireExisting(this.projects.get(id), "项目");
    const updated: ProductionProject = { ...current, ...patch, updatedAt: now() };
    this.projects.set(id, updated);
    return updated;
  }

  // ================= Episode =================

  async createEpisode(data: NewEpisode): Promise<ProductionEpisode> {
    const entity: ProductionEpisode = { ...data, id: randomId("epi"), createdAt: now(), updatedAt: now() };
    this.episodes.set(entity.id, entity);
    return entity;
  }

  async getEpisode(id: string): Promise<ProductionEpisode | null> {
    return this.episodes.get(id) ?? null;
  }

  async listEpisodes(projectId: string): Promise<ProductionEpisode[]> {
    return [...this.episodes.values()].filter((e) => e.projectId === projectId);
  }

  async updateEpisode(id: string, patch: EpisodePatch): Promise<ProductionEpisode | null> {
    const current = this.episodes.get(id);
    if (!current) return null;
    const updated: ProductionEpisode = { ...current, ...patch, updatedAt: now() };
    this.episodes.set(id, updated);
    return updated;
  }

  async deleteEpisode(id: string): Promise<void> {
    this.episodes.delete(id);
  }

  async createScript(data: NewScript): Promise<ProductionScript> {
    const entity: ProductionScript = { ...data, id: randomId("sct"), createdAt: now(), updatedAt: now() };
    this.scripts.set(entity.id, entity);
    return entity;
  }

  async getScript(id: string): Promise<ProductionScript | null> {
    return this.scripts.get(id) ?? null;
  }

  async listScripts(projectId: string, episodeId?: string): Promise<ProductionScript[]> {
    return [...this.scripts.values()].filter((s) => s.projectId === projectId && (episodeId === undefined || s.episodeId === episodeId));
  }

  async updateScript(id: string, patch: ScriptPatch): Promise<ProductionScript> {
    const current = this.requireExisting(this.scripts.get(id), "剧本");
    const updated: ProductionScript = { ...current, ...patch, updatedAt: now() };
    this.scripts.set(id, updated);
    return updated;
  }

  async deleteScript(id: string): Promise<void> {
    this.scripts.delete(id);
  }

  async createCharacter(data: NewCharacter): Promise<Character> {
    const entity: Character = { ...data, id: randomId("chr"), createdAt: now(), updatedAt: now() };
    this.characters.set(entity.id, entity);
    return entity;
  }

  async getCharacter(id: string): Promise<Character | null> {
    return this.characters.get(id) ?? null;
  }

  async listCharacters(projectId: string): Promise<Character[]> {
    return [...this.characters.values()].filter((c) => c.projectId === projectId);
  }

  async updateCharacter(id: string, patch: CharacterPatch): Promise<Character> {
    const current = this.requireExisting(this.characters.get(id), "角色");
    const { voiceAssetId, ...rest } = patch;
    // 与真实 drizzle 仓储语义一致：null = 清空该列（领域输出统一 undefined），undefined = 不动
    const updated: Character = { ...current, ...rest, updatedAt: now() };
    if (voiceAssetId !== undefined) {
      updated.voiceAssetId = voiceAssetId ?? undefined;
    }
    this.characters.set(id, updated);
    return updated;
  }

  async deleteCharacter(id: string): Promise<void> {
    this.characters.delete(id);
  }

  async createScene(data: NewScene): Promise<ProductionScene> {
    const entity: ProductionScene = { ...data, id: randomId("scn"), createdAt: now(), updatedAt: now() };
    this.scenes.set(entity.id, entity);
    return entity;
  }

  async getScene(id: string): Promise<ProductionScene | null> {
    return this.scenes.get(id) ?? null;
  }

  async listScenes(projectId: string, episodeId?: string): Promise<ProductionScene[]> {
    return [...this.scenes.values()].filter((s) => s.projectId === projectId && (episodeId === undefined || s.episodeId === episodeId));
  }

  async updateScene(id: string, patch: ScenePatch): Promise<ProductionScene> {
    const current = this.requireExisting(this.scenes.get(id), "场景");
    const updated: ProductionScene = { ...current, ...patch, updatedAt: now() };
    this.scenes.set(id, updated);
    return updated;
  }

  async deleteScene(id: string): Promise<void> {
    // 模拟 DB 外键级联：删除场景时一并清理其分镜与镜头
    const toDelete = [...this.storyboards.values()].filter((s) => s.sceneId === id);
    for (const sb of toDelete) {
      this.storyboards.delete(sb.id);
      for (const shot of [...this.shots.values()]) {
        if (shot.storyboardId === sb.id) this.shots.delete(shot.id);
      }
    }
    this.scenes.delete(id);
  }

  async createStoryboard(data: NewStoryboard): Promise<Storyboard> {
    const entity: Storyboard = { ...data, id: randomId("sbd"), createdAt: now(), updatedAt: now() };
    this.storyboards.set(entity.id, entity);
    return entity;
  }

  async getStoryboard(id: string): Promise<Storyboard | null> {
    return this.storyboards.get(id) ?? null;
  }

  async listStoryboards(projectId: string): Promise<Storyboard[]> {
    return [...this.storyboards.values()].filter((s) => s.projectId === projectId);
  }

  async listStoryboardsByScene(sceneId: string): Promise<Storyboard[]> {
    return [...this.storyboards.values()].filter((s) => s.sceneId === sceneId);
  }

  async updateStoryboard(id: string, patch: StoryboardPatch): Promise<Storyboard> {
    const current = this.requireExisting(this.storyboards.get(id), "分镜");
    const updated: Storyboard = { ...current, ...patch, updatedAt: now() };
    this.storyboards.set(id, updated);
    return updated;
  }

  async deleteStoryboard(id: string): Promise<void> {
    // 模拟 DB 外键级联：删除分镜时一并清理其镜头
    for (const shot of [...this.shots.values()]) {
      if (shot.storyboardId === id) this.shots.delete(shot.id);
    }
    this.storyboards.delete(id);
  }

  async createShot(data: NewShot): Promise<ProductionShot> {
    const entity: ProductionShot = { ...data, id: randomId("sht"), createdAt: now(), updatedAt: now() };
    this.shots.set(entity.id, entity);
    return entity;
  }

  async getShot(id: string): Promise<ProductionShot | null> {
    return this.shots.get(id) ?? null;
  }

  async listShots(projectId: string, episodeId?: string): Promise<ProductionShot[]> {
    if (episodeId === undefined) {
      return [...this.shots.values()].filter((s) => s.projectId === projectId);
    }
    const sceneIds = new Set(
      [...this.scenes.values()].filter((sc) => sc.projectId === projectId && sc.episodeId === episodeId).map((sc) => sc.id),
    );
    const sbIds = new Set(
      [...this.storyboards.values()].filter((sb) => sceneIds.has(sb.sceneId)).map((sb) => sb.id),
    );
    return [...this.shots.values()].filter((s) => s.projectId === projectId && sbIds.has(s.storyboardId));
  }

  async listShotsByStoryboard(storyboardId: string): Promise<ProductionShot[]> {
    return [...this.shots.values()].filter((s) => s.storyboardId === storyboardId);
  }

  async updateShot(id: string, patch: ShotPatch): Promise<ProductionShot> {
    const current = this.requireExisting(this.shots.get(id), "镜头");
    const updated: ProductionShot = { ...current, ...patch, updatedAt: now() };
    this.shots.set(id, updated);
    return updated;
  }

  async deleteShot(id: string): Promise<void> {
    this.shots.delete(id);
  }

  async createAsset(data: NewAsset): Promise<ProductionAsset> {
    const entity: ProductionAsset = { ...data, id: randomId("ast"), createdAt: now(), updatedAt: now() };
    this.assets.set(entity.id, entity);
    return entity;
  }

  async getAsset(id: string): Promise<ProductionAsset | null> {
    return this.assets.get(id) ?? null;
  }

  async listAssets(projectId: string, type?: AssetType): Promise<ProductionAsset[]> {
    return [...this.assets.values()].filter(
      (a) => a.projectId === projectId && (type === undefined || a.type === type),
    );
  }

  async updateAssetFields(id: string, patch: AssetFieldsPatch): Promise<ProductionAsset | null> {
    const current = this.assets.get(id);
    if (!current) {
      return null;
    }
    const updated: ProductionAsset = { ...current, updatedAt: now() };
    // 与 drizzle 适配器同款语义：null = 清列，键缺省 = 不动
    if (patch.workspacePath !== undefined) {
      updated.workspacePath = patch.workspacePath ?? undefined;
    }
    if (patch.metadata !== undefined) {
      updated.metadata = patch.metadata ?? undefined;
    }
    if (patch.mimeType !== undefined) {
      updated.mimeType = patch.mimeType ?? undefined;
    }
    this.assets.set(id, updated);
    return updated;
  }

  async updateAsset(id: string, patch: AssetPatch): Promise<ProductionAsset | null> {
    const current = this.assets.get(id);
    if (!current) {
      return null;
    }
    const updated: ProductionAsset = { ...current, ...patch, updatedAt: now() };
    this.assets.set(id, updated);
    return updated;
  }

  async deleteAsset(id: string): Promise<void> {
    this.assets.delete(id);
  }

  async findAssetByTask(taskId: string): Promise<ProductionAsset | null> {
    return [...this.assets.values()].find((a) => a.generation?.taskId === taskId) ?? null;
  }

  async createAssetLibraryRef(data: NewAssetLibraryRef): Promise<void> {
    this.libraryRefs.set(`${data.assetId}:${data.libPath}`, {
      id: randomId("rlr"),
      projectId: data.projectId,
      assetId: data.assetId,
      libPath: data.libPath,
      createdAt: now(),
    });
  }

  async listAssetLibraryRefsByFolder(folder: string): Promise<AssetLibraryRefView[]> {
    const prefix = `${folder}/`;
    return [...this.libraryRefs.values()].map((r) => ({
      libPath: r.libPath,
      projectId: r.projectId,
      projectName: this.projects.get(r.projectId)?.name ?? r.projectId,
      assetId: r.assetId,
      assetName: this.assets.get(r.assetId)?.name ?? r.assetId,
    })).filter((r) => r.libPath.startsWith(prefix));
  }

  async createGenerationRecord(data: NewGenerationRecord): Promise<GenerationRecord> {
    const entity: GenerationRecord = { ...data, id: randomId("gen"), createdAt: now(), updatedAt: now() };
    this.generationRecords.set(entity.id, entity);
    return entity;
  }

  async getGenerationRecord(id: string): Promise<GenerationRecord | null> {
    return this.generationRecords.get(id) ?? null;
  }

  async listGenerationRecords(
    projectId: string,
    filter?: { shotId?: string; storyboardId?: string; kind?: GenerationKind; reviewStatus?: GenerationReviewStatus },
  ): Promise<GenerationRecord[]> {
    return [...this.generationRecords.values()].filter(
      (r) =>
        r.projectId === projectId &&
        (filter?.shotId === undefined || r.shotId === filter.shotId) &&
        (filter?.storyboardId === undefined || r.storyboardId === filter.storyboardId) &&
        (filter?.kind === undefined || r.kind === filter.kind) &&
        (filter?.reviewStatus === undefined || r.reviewStatus === filter.reviewStatus),
    );
  }

  async listGenerationRecordsByShot(shotId: string): Promise<GenerationRecord[]> {
    return [...this.generationRecords.values()].filter((r) => r.shotId === shotId);
  }

  async updateGenerationRecord(id: string, patch: GenerationRecordPatch): Promise<GenerationRecord | null> {
    const current = this.generationRecords.get(id);
    if (!current) return null;
    const updated: GenerationRecord = { ...current, ...patch, updatedAt: now() };
    this.generationRecords.set(id, updated);
    return updated;
  }

  async updateGenerationRecordsByTask(
    taskId: string,
    patch: { status: GenerationRecordStatus; outputAssetId: string },
  ): Promise<void> {
    for (const [id, record] of this.generationRecords) {
      if (record.taskId === taskId) {
        this.generationRecords.set(id, { ...record, ...patch, updatedAt: now() });
      }
    }
  }

  async transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T> {
    // 内存实现共享同一状态即可，无需真正隔离
    return fn(this);
  }

  // ================= Timeline（V0.3 Phase 2） =================

  async createTimeline(data: NewTimeline): Promise<ProductionTimeline> {
    const entity: ProductionTimeline = { ...data, id: randomId("tml"), createdAt: now(), updatedAt: now() };
    this.timelines.set(entity.id, entity);
    return entity;
  }

  async getTimeline(id: string): Promise<ProductionTimeline | null> {
    return this.timelines.get(id) ?? null;
  }

  async listTimelines(projectId: string, episodeId?: string): Promise<ProductionTimeline[]> {
    return [...this.timelines.values()].filter((t) => t.projectId === projectId && (episodeId === undefined || t.episodeId === episodeId));
  }

  async updateTimeline(id: string, patch: TimelinePatch): Promise<ProductionTimeline | null> {
    const current = this.timelines.get(id);
    if (!current) return null;
    const updated: ProductionTimeline = { ...current, ...patch, updatedAt: now() };
    this.timelines.set(id, updated);
    return updated;
  }

  async deleteTimeline(id: string): Promise<void> {
    this.timelines.delete(id);
    for (const [trackId, track] of this.timelineTracks) {
      if (track.timelineId === id) {
        this.timelineTracks.delete(trackId);
      }
    }
    for (const [clipId, clip] of this.timelineClips) {
      if (clip.timelineId === id) {
        this.timelineClips.delete(clipId);
      }
    }
  }

  async createTimelineTrack(data: NewTimelineTrack): Promise<TimelineTrack> {
    const entity: TimelineTrack = { ...data, id: randomId("trk"), createdAt: now(), updatedAt: now() };
    this.timelineTracks.set(entity.id, entity);
    return entity;
  }

  async getTimelineTrack(id: string): Promise<TimelineTrack | null> {
    return this.timelineTracks.get(id) ?? null;
  }

  async listTimelineTracks(timelineId: string): Promise<TimelineTrack[]> {
    return [...this.timelineTracks.values()]
      .filter((t) => t.timelineId === timelineId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  async updateTimelineTrack(id: string, patch: TimelineTrackPatch): Promise<TimelineTrack | null> {
    const current = this.timelineTracks.get(id);
    if (!current) return null;
    const updated: TimelineTrack = { ...current, ...patch, updatedAt: now() };
    this.timelineTracks.set(id, updated);
    return updated;
  }

  async deleteTimelineTrack(id: string): Promise<void> {
    this.timelineTracks.delete(id);
    for (const [clipId, clip] of this.timelineClips) {
      if (clip.trackId === id) {
        this.timelineClips.delete(clipId);
      }
    }
  }

  async createTimelineClip(data: NewTimelineClip): Promise<TimelineClip> {
    const entity: TimelineClip = { ...data, id: randomId("clp"), createdAt: now(), updatedAt: now() };
    this.timelineClips.set(entity.id, entity);
    return entity;
  }

  async getTimelineClip(id: string): Promise<TimelineClip | null> {
    return this.timelineClips.get(id) ?? null;
  }

  async listTimelineClips(timelineId: string): Promise<TimelineClip[]> {
    return [...this.timelineClips.values()]
      .filter((c) => c.timelineId === timelineId)
      .sort((a, b) => a.startTime - b.startTime || a.order - b.order || a.id.localeCompare(b.id));
  }

  async listTimelineClipsByTrack(trackId: string): Promise<TimelineClip[]> {
    return [...this.timelineClips.values()]
      .filter((c) => c.trackId === trackId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  async updateTimelineClip(id: string, patch: TimelineClipPatch): Promise<TimelineClip | null> {
    const current = this.timelineClips.get(id);
    if (!current) return null;
    const updated: TimelineClip = {
      ...current,
      ...patch,
      assetId: patch.assetId === null ? undefined : (patch.assetId ?? current.assetId),
      shotId: patch.shotId === null ? undefined : (patch.shotId ?? current.shotId),
      updatedAt: now(),
    };
    this.timelineClips.set(id, updated);
    return updated;
  }

  async deleteTimelineClip(id: string): Promise<void> {
    this.timelineClips.delete(id);
  }

  private requireExisting<T>(row: T | undefined, entity: string): T {
    if (row === undefined) {
      throw new Error(`[Fake] ${entity} 不存在`);
    }
    return row;
  }
}
