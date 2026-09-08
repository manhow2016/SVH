/**
 * Timeline 服务（V0.3 文档 Phase 3：Timeline Service）。
 *
 * 职责：Timeline / Track / Clip 的创建、查询、更新、删除与重排编排。
 *
 * 分层（与既有生产实体同一纪律）：
 * - 字段级校验与规则断言 → @svh/production `timeline/` 领域函数；
 * - 行 ↔ 实体映射 → @svh/production DrizzleProductionRepository；
 * - 本类只做：实体存在性/归属加载、跨实体上下文校验（Clip 规则 3/4/6/7/8）、
 *   派生值维护（timeline.duration = max clip end；内容变更 version +1）、
 *   重排（order 批量写入，集合一致性校验）。
 *
 * 错误一律抛 @svh/production ProductionError（NOT_FOUND / VALIDATION / CONFLICT）。
 */
import {
  applyTimelineStatus,
  assertClipAssetMatchesTrack,
  assertClipStartsWithinTimeline,
  assertSameProject,
  buildAutoTimelinePlan,
  bumpTimelineVersion,
  computeTimelineDuration,
  isTimelineStatus,
  isTimelineTrackType,
  normalizeTimelineClipCreateInput,
  normalizeTimelineCreateInput,
  normalizeTimelineTrackCreateInput,
  notFoundError,
  validateTimelineDescription,
  validateTimelineDimensions,
  validateTimelineDuration,
  validateTimelineFps,
  validateTimelineName,
  type AutoTimelineSkippedShot,
  type CreateTimelineClipInput,
  type CreateTimelineInput,
  type CreateTimelineTrackInput,
  type GenerationRecord,
  type ProductionRepository,
  type ProductionTimeline,
  type TimelineClip,
  type TimelineTrack,
  type UpdateTimelineClipInput,
  type UpdateTimelineInput,
  type UpdateTimelineTrackInput,
  validationError,
} from "@svh/production";

export interface TimelineDetail {
  timeline: ProductionTimeline;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

// ---- Auto Timeline（V0.3 文档 Phase 5） ----

export interface AutoCreateTimelineInput {
  /** 缺省为「自动时间轴 YYYY-MM-DD HH:mm」 */
  name?: string;
  description?: string;
  fps?: number;
  width?: number;
  height?: number;
}

/** 自动时间轴结果：detail + 无法入轨的镜头说明 */
export interface AutoCreateTimelineResult extends TimelineDetail {
  skipped: AutoTimelineSkippedShot[];
}

export class TimelineService {
  constructor(private readonly repo: ProductionRepository) {}

  // ================= Timeline =================

  async createTimeline(input: CreateTimelineInput): Promise<ProductionTimeline> {
    await this.assertProjectExists(input.projectId);
    const data = normalizeTimelineCreateInput(input);
    return this.repo.createTimeline({ ...data, status: "draft", version: 0 });
  }

  async getTimeline(id: string): Promise<ProductionTimeline> {
    const timeline = await this.repo.getTimeline(id);
    if (!timeline) {
      throw notFoundError("时间轴");
    }
    return timeline;
  }

  async listTimelines(projectId: string): Promise<ProductionTimeline[]> {
    return this.repo.listTimelines(projectId);
  }

  async getTimelineDetail(id: string): Promise<TimelineDetail> {
    const timeline = await this.getTimeline(id);
    const [tracks, clips] = await Promise.all([
      this.repo.listTimelineTracks(id),
      this.repo.listTimelineClips(id),
    ]);
    return { timeline, tracks, clips };
  }

  async updateTimeline(id: string, patch: UpdateTimelineInput): Promise<ProductionTimeline> {
    const current = await this.getTimeline(id);
    const next: UpdateTimelineInput = {};
    if (patch.name !== undefined) {
      next.name = validateTimelineName(patch.name);
    }
    if (patch.description !== undefined) {
      next.description = validateTimelineDescription(patch.description);
    }
    if (patch.fps !== undefined) {
      next.fps = validateTimelineFps(patch.fps);
    }
    if (patch.width !== undefined || patch.height !== undefined) {
      const { width, height } = validateTimelineDimensions(
        patch.width ?? current.width,
        patch.height ?? current.height,
      );
      next.width = width;
      next.height = height;
    }
    if (patch.status !== undefined) {
      if (!isTimelineStatus(patch.status)) {
        throw validationError("时间轴状态不合法");
      }
      next.status = applyTimelineStatus(current.status, patch.status);
    }
    // duration / version 为派生列（由剪辑内容推算），人工 patch 一律忽略
    if (Object.keys(next).length === 0) {
      throw validationError("updateTimeline 至少需要一个可更新字段（duration/version 为派生列）");
    }
    const updated = await this.repo.updateTimeline(id, next);
    if (!updated) {
      throw notFoundError("时间轴");
    }
    return updated;
  }

  async deleteTimeline(id: string): Promise<void> {
    await this.getTimeline(id);
    // 轨道与剪辑由数据库外键级联删除
    await this.repo.deleteTimeline(id);
  }

  // ================= Auto Timeline（Phase 5） =================

  /**
   * 按项目镜头自动生成成片时间轴（文档 Phase 5）：
   * 加载层级数据（场景/分镜/镜头/视频素材/生成记录）→ 领域纯函数生成计划
   * （排序 + 素材裁决 + 累计 startTime）→ 事务内一次写入（timeline + 单条 video 轨 + 剪辑），
   * 派生列（duration / version）走 refreshTimeline 统一维护。
   *
   * 素材裁决（领域规则）：优先 shot.videoAssetId，否则该镜头最新完成的视频生成记录；
   * 无素材的镜头跳过并随结果返回（不阻断整体生成）。全部无素材时抛 VALIDATION。
   */
  async autoCreateTimeline(
    projectId: string,
    input: AutoCreateTimelineInput = {},
  ): Promise<AutoCreateTimelineResult> {
    await this.assertProjectExists(projectId);
    const [scenes, storyboards, shots, videoAssets, records] = await Promise.all([
      this.repo.listScenes(projectId),
      this.repo.listStoryboards(projectId),
      this.repo.listShots(projectId),
      this.repo.listAssets(projectId, "video"),
      this.repo.listGenerationRecords(projectId, { kind: "video" }),
    ]);
    // 生成记录按镜头分组（只收集带 shotId 的记录）
    const recordsByShot = new Map<string, GenerationRecord[]>();
    for (const record of records) {
      if (!record.shotId) continue;
      const group = recordsByShot.get(record.shotId);
      if (group) {
        group.push(record);
      } else {
        recordsByShot.set(record.shotId, [record]);
      }
    }
    // 可用素材 = 本项目现存 video 资产（类型与项目归属已在集合构建时保证）
    const usableAssetIds = new Set(videoAssets.map((a) => a.id));
    const plan = buildAutoTimelinePlan({ scenes, storyboards, shots, recordsByShot, usableAssetIds });
    if (plan.clips.length === 0) {
      throw validationError("项目没有可用的已就绪视频素材，无法自动生成时间轴");
    }
    const data = normalizeTimelineCreateInput({
      projectId,
      name: input.name ?? defaultAutoTimelineName(),
      description: input.description,
      fps: input.fps,
      width: input.width,
      height: input.height,
    });
    const timeline = await this.repo.transaction(async (repo) => {
      const createdTimeline = await repo.createTimeline({ ...data, status: "draft", version: 0 });
      const track = await repo.createTimelineTrack({
        timelineId: createdTimeline.id,
        type: "video",
        name: "视频轨",
        order: 0,
      });
      for (const clip of plan.clips) {
        await repo.createTimelineClip({
          timelineId: createdTimeline.id,
          trackId: track.id,
          assetId: clip.assetId,
          shotId: clip.shotId,
          startTime: clip.startTime,
          duration: clip.duration,
          sourceStartTime: clip.sourceStartTime,
          sourceDuration: clip.sourceDuration,
          order: clip.order,
        });
      }
      await this.refreshTimeline(repo, createdTimeline.id);
      return createdTimeline;
    });
    const updated = await this.getTimeline(timeline.id);
    const [tracks, clips] = await Promise.all([
      this.repo.listTimelineTracks(timeline.id),
      this.repo.listTimelineClips(timeline.id),
    ]);
    return { timeline: updated, tracks, clips, skipped: plan.skipped };
  }

  // ================= Track =================

  async createTrack(input: CreateTimelineTrackInput): Promise<TimelineTrack> {
    await this.getTimeline(input.timelineId);
    const data = normalizeTimelineTrackCreateInput(input);
    const tracks = await this.repo.listTimelineTracks(input.timelineId);
    const order = data.order ?? nextOrder(tracks.map((t) => t.order));
    return this.repo.createTimelineTrack({
      timelineId: input.timelineId,
      type: data.type,
      name: data.name,
      order,
      muted: data.muted ?? false,
      locked: data.locked ?? false,
    });
  }

  async updateTrack(id: string, patch: UpdateTimelineTrackInput): Promise<TimelineTrack> {
    await this.getTrack(id);
    const next: UpdateTimelineTrackInput = {};
    if (patch.name !== undefined) {
      next.name = validateTimelineName(patch.name);
    }
    if (patch.type !== undefined) {
      if (!isTimelineTrackType(patch.type)) {
        throw validationError("轨道类型不合法");
      }
      next.type = patch.type;
    }
    if (patch.order !== undefined) {
      next.order = assertNonNegativeInt(patch.order, "轨道顺序");
    }
    // muted / locked 允许显式置回 false：undefined 不动、boolean 原样
    if (patch.muted !== undefined) {
      next.muted = patch.muted;
    }
    if (patch.locked !== undefined) {
      next.locked = patch.locked;
    }
    if (Object.keys(next).length === 0) {
      throw validationError("updateTrack 至少需要一个可更新字段");
    }
    const updated = await this.repo.updateTimelineTrack(id, next);
    if (!updated) {
      throw notFoundError("轨道");
    }
    return updated;
  }

  async deleteTrack(id: string): Promise<void> {
    const track = await this.getTrack(id);
    // 同轨剪辑由外键级联删除；删除后重算时间轴时长与版本
    await this.repo.transaction(async (repo) => {
      await repo.deleteTimelineTrack(id);
      await this.refreshTimeline(repo, track.timelineId);
    });
  }

  async reorderTracks(timelineId: string, orderedTrackIds: string[]): Promise<TimelineTrack[]> {
    await this.getTimeline(timelineId);
    const tracks = await this.repo.listTimelineTracks(timelineId);
    assertSameIdSet(orderedTrackIds, tracks.map((t) => t.id), "轨道");
    return this.repo.transaction(async (repo) => {
      for (let i = 0; i < orderedTrackIds.length; i++) {
        await repo.updateTimelineTrack(orderedTrackIds[i]!, { order: i });
      }
      return repo.listTimelineTracks(timelineId);
    });
  }

  // ================= Clip =================

  async createClip(input: CreateTimelineClipInput): Promise<TimelineClip> {
    const timeline = await this.getTimeline(input.timelineId);
    const track = await this.getTrack(input.trackId);
    if (track.timelineId !== timeline.id) {
      throw validationError("轨道不属于该时间轴");
    }
    const data = normalizeTimelineClipCreateInput(input);
    await this.assertClipContext(timeline, track, data);
    const clips = await this.repo.listTimelineClipsByTrack(input.trackId);
    const order = data.order ?? nextOrder(clips.map((c) => c.order));
    return this.repo.transaction(async (repo) => {
      const clip = await repo.createTimelineClip({
        timelineId: input.timelineId,
        trackId: input.trackId,
        assetId: data.assetId,
        shotId: data.shotId,
        startTime: data.startTime,
        duration: data.duration,
        sourceStartTime: data.sourceStartTime,
        sourceDuration: data.sourceDuration,
        order,
        metadata: data.metadata,
      });
      await this.refreshTimeline(repo, timeline.id);
      return clip;
    });
  }

  async updateClip(id: string, patch: UpdateTimelineClipInput): Promise<TimelineClip> {
    const current = await this.getClip(id);
    const timeline = await this.getTimeline(current.timelineId);
    const track = await this.getTrack(current.trackId);
    const next: {
      assetId?: string | null;
      shotId?: string | null;
      startTime?: number;
      duration?: number;
      sourceStartTime?: number;
      sourceDuration?: number;
      order?: number;
      metadata?: Record<string, unknown>;
    } = {};
    // 关联列：null = 显式解绑（写入 SQL NULL），undefined = 不动
    if (patch.assetId !== undefined) {
      next.assetId = patch.assetId;
    }
    if (patch.shotId !== undefined) {
      next.shotId = patch.shotId;
    }
    if (patch.startTime !== undefined) {
      next.startTime = assertNonNegative(patch.startTime, "剪辑起点");
    }
    if (patch.duration !== undefined) {
      next.duration = validateTimelineDuration(patch.duration);
    }
    if (patch.sourceStartTime !== undefined) {
      next.sourceStartTime = assertNonNegative(patch.sourceStartTime, "源素材起点");
    }
    if (patch.sourceDuration !== undefined) {
      next.sourceDuration = validateTimelineDuration(patch.sourceDuration);
    }
    if (patch.order !== undefined) {
      next.order = assertNonNegativeInt(patch.order, "剪辑顺序");
    }
    if (patch.metadata !== undefined) {
      next.metadata = patch.metadata;
    }
    if (Object.keys(next).length === 0) {
      throw validationError("updateClip 至少需要一个可更新字段");
    }
    // 合并后数据 → 上下文校验（track 换绑不允许，故 trackId 不在可更新字段内）
    const merged = {
      assetId: patch.assetId !== undefined ? patch.assetId ?? undefined : current.assetId,
      shotId: patch.shotId !== undefined ? patch.shotId ?? undefined : current.shotId,
      startTime: next.startTime ?? current.startTime,
      duration: next.duration ?? current.duration,
    };
    await this.assertClipContext(timeline, track, merged);
    return this.repo.transaction(async (repo) => {
      const updated = await repo.updateTimelineClip(id, next);
      if (!updated) {
        throw notFoundError("剪辑");
      }
      await this.refreshTimeline(repo, timeline.id);
      return updated;
    });
  }

  async deleteClip(id: string): Promise<void> {
    const clip = await this.getClip(id);
    await this.repo.transaction(async (repo) => {
      await repo.deleteTimelineClip(id);
      await this.refreshTimeline(repo, clip.timelineId);
    });
  }

  async reorderClips(trackId: string, orderedClipIds: string[]): Promise<TimelineClip[]> {
    await this.getTrack(trackId); // 存在性校验（轨道不存在抛 NOT_FOUND）
    const clips = await this.repo.listTimelineClipsByTrack(trackId);
    assertSameIdSet(orderedClipIds, clips.map((c) => c.id), "剪辑");
    return this.repo.transaction(async (repo) => {
      for (let i = 0; i < orderedClipIds.length; i++) {
        await repo.updateTimelineClip(orderedClipIds[i]!, { order: i });
      }
      return repo.listTimelineClipsByTrack(trackId);
    });
  }

  // ================= 内部 =================

  private async assertProjectExists(projectId: string): Promise<void> {
    const project = await this.repo.getProject(projectId);
    if (!project) {
      throw notFoundError("项目");
    }
  }

  /** 加载轨道并校验存在（归属校验/后续编排复用） */
  async getTrack(id: string): Promise<TimelineTrack> {
    const track = await this.repo.getTimelineTrack(id);
    if (!track) {
      throw notFoundError("轨道");
    }
    return track;
  }

  /** 加载剪辑并校验存在（归属校验/后续编排复用） */
  async getClip(id: string): Promise<TimelineClip> {
    const clip = await this.repo.getTimelineClip(id);
    if (!clip) {
      throw notFoundError("剪辑");
    }
    return clip;
  }

  /**
   * Clip 上下文校验（规则 3/4/6/7/8）：
   * - 起点不得超过时间轴当前时长（终点允许延伸，随后 refreshTimeline 扩长）；
   * - video/audio 轨道必须绑定同类型资产，且资产/镜头必须属于同一项目。
   */
  /**
   * Clip 上下文校验（规则 3/4/6/7/8）：
   * - 规则 6：起点不得超过时间轴当前时长（终点允许延伸，随后 refreshTimeline 扩长）；
   * - 规则 3/4：video/audio 轨道必须绑定同类型资产；
   * - 规则 7/8：资产/镜头必须属于同一项目。
   *
   * 注意：渲染前对最终 duration 的整轴校验（end 不越界）在 Phase 7 用
   * validateClipAgainstContext（固定时长语义），编辑期允许延伸。
   */
  private async assertClipContext(
    timeline: ProductionTimeline,
    track: TimelineTrack,
    clip: Pick<TimelineClip, "assetId" | "shotId" | "startTime" | "duration">,
  ): Promise<void> {
    assertClipStartsWithinTimeline(clip.startTime, timeline.duration);
    if (track.type === "video" || track.type === "audio") {
      if (clip.assetId === undefined) {
        throw validationError("video/audio 轨道剪辑必须关联资产");
      }
    }
    let asset: { type: "image" | "video" | "audio" | "document" | "subtitle" | "reference"; projectId: string } | null = null;
    if (clip.assetId !== undefined) {
      const found = await this.repo.getAsset(clip.assetId);
      if (!found) {
        throw notFoundError("资产");
      }
      asset = { type: found.type, projectId: found.projectId };
    }
    let shot: { projectId: string } | null = null;
    if (clip.shotId !== undefined) {
      const found = await this.repo.getShot(clip.shotId);
      if (!found) {
        throw notFoundError("镜头");
      }
      shot = { projectId: found.projectId };
    }
    assertClipAssetMatchesTrack(track.type, asset?.type);
    if (asset) {
      assertSameProject(timeline.projectId, asset.projectId, `资产 ${clip.assetId}`);
    }
    if (shot) {
      assertSameProject(timeline.projectId, shot.projectId, `镜头 ${clip.shotId}`);
    }
  }

  /**
   * 重算时间轴派生列：duration = max clip end；内容变更 version +1。
   * 必须在事务内调用（写入与读取一致）。
   */
  private async refreshTimeline(
    repo: ProductionRepository,
    timelineId: string,
  ): Promise<void> {
    const timeline = await repo.getTimeline(timelineId);
    if (!timeline) {
      return;
    }
    const clips = await repo.listTimelineClips(timelineId);
    // 事务内必然有新版本（内容已变更）；duration == 旧值时为纯重排/删除等场景仍 +1，
    // 保证「任意剪辑内容变更 → version 递增」的不变量成立。
    await repo.updateTimeline(timelineId, {
      duration: computeTimelineDuration(clips),
      version: bumpTimelineVersion(timeline.version),
    });
  }
}

/** 默认顺序：同集合现有最大值 + 1（空集合 = 0） */
function nextOrder(existing: number[]): number {
  return existing.length === 0 ? 0 : Math.max(...existing) + 1;
}

/** 自动时间轴缺省名称：「自动时间轴 YYYY-MM-DD HH:mm」（本地时间） */
function defaultAutoTimelineName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `自动时间轴 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 重排输入必须与现有实体集合完全一致（同集、无缺失、无多余、无重复） */
function assertSameIdSet(orderedIds: string[], existingIds: string[], label: string): void {
  if (new Set(orderedIds).size !== orderedIds.length || orderedIds.length !== existingIds.length) {
    throw validationError(`${label}重排输入数量与现有${label}集合不一致`);
  }
  const existing = new Set(existingIds);
  for (const id of orderedIds) {
    if (!existing.has(id)) {
      throw validationError(`${label}重排输入包含不属于该范围的 id：${id}`);
    }
  }
}

function assertNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw validationError(`${field}必须为 >= 0 的整数`);
  }
  return value;
}

function assertNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw validationError(`${field}必须为 >= 0 的数值`);
  }
  return value;
}
