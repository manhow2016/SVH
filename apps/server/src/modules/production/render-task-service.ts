/**
 * Timeline 渲染任务服务（V0.3 文档 Phase 7：Render Task）。
 *
 * 职责：把「时间轴 → 成片」建模为异步任务（production_tasks, kind =
 * timeline_render）。步骤：
 * 1. 状态机前置校验：仅 ready → rendering（其余抛 CONFLICT）；
 * 2. 固定时长整轴校验：逐剪辑 `validateClipAgainstContext`
 *    （规则 3/4/6/7/8 + end 不越轴——渲染期用整轴语义，区别于编辑期
 *    `assertClipStartsWithinTimeline` 的延伸语义）；
 * 3. 必须存在 video 轨剪辑（成片画面来源）；
 * 4. 同一事务：先切状态 rendering + 落一条 queued 任务
 *    （payload = 入队时刻的剪辑静态快照，worker 渲染与后续编辑解耦）。
 *
 * 任务执行（FFmpeg）在 Phase 8（worker）；渲染完成/失败后由 worker 回写
 * timeline 状态 completed/failed（Phase 8 契约）。
 */
import { randomId } from "@svh/shared";
import { productionTasks as tasksTable, type SVHDatabase } from "@svh/database";
import {
  applyTimelineStatus,
  conflictError,
  notFoundError,
  validateClipAgainstContext,
  validationError,
  type ProductionRepository,
  type ProductionTimeline,
  type TimelineClip,
  type TimelineTrack,
} from "@svh/production";

export interface RenderTaskDeps {
  db: SVHDatabase;
  /** 领域仓储（事务与原语访问；与 db 同一 SQLite 连接） */
  repo: ProductionRepository;
}

/**
 * worker 执行参数（v1）。与 Phase 8 `apps/worker` 渲染侧手写字面量同形——
 * 刻意不跨包 import（经 JSON 契约解耦），改动需双侧同步。
 */
export interface TimelineRenderTaskPayload {
  v: number;
  timelineId: string;
  projectId: string;
  /** 入队时刻的时间轴版本（调试/对账） */
  version: number;
  fps: number;
  width: number;
  height: number;
  /** 剪辑静态快照（演示顺序稳定：按 track.order → clip.order 展开） */
  clips: Array<{
    clipId: string;
    trackId: string;
    trackType: TimelineTrack["type"];
    assetId?: string;
    shotId?: string;
    startTime: number;
    duration: number;
    sourceStartTime?: number;
    sourceDuration?: number;
  }>;
}

/** 任务视图（白名单，与 GenerationService.ProductionTaskView 同形，不含 payload） */
export interface RenderTaskView {
  id: string;
  projectId: string;
  userId: string;
  kind: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderTaskResult {
  task: RenderTaskView;
  timeline: ProductionTimeline;
}

export class RenderTaskService {
  constructor(private readonly deps: RenderTaskDeps) {}

  /**
   * 渲染入队：校验 → 状态机 → 事务内（状态 + 任务）原子写入。
   * @param timelineId 时间轴 id
   * @param userId 发起人（任务归属；时间轴归属校验由路由层完成）
   */
  async renderTimeline(timelineId: string, userId: string): Promise<RenderTaskResult> {
    const timeline = await this.deps.repo.getTimeline(timelineId);
    if (!timeline) {
      throw notFoundError("时间轴");
    }
    if (timeline.status === "rendering") {
      // 同状态重复提交：applyTimelineStatus 视为 no-op，此处显式拒绝（防重复入队）
      throw conflictError("时间轴正在渲染中，请勿重复提交");
    }
    // 状态机：ready → rendering 唯一合法入口（draft/editing/completed/failed 抛 CONFLICT）
    const nextStatus = applyTimelineStatus(timeline.status, "rendering");

    const [tracks, clips] = await Promise.all([
      this.deps.repo.listTimelineTracks(timelineId),
      this.deps.repo.listTimelineClips(timelineId),
    ]);
    // 成片画面来源：至少一条 video 轨剪辑
    const videoTracks = tracks.filter((t) => t.type === "video");
    const videoClips = clips.filter((c) => videoTracks.some((t) => t.id === c.trackId));
    if (videoClips.length === 0) {
      throw validationError("时间轴没有视频轨剪辑，无法渲染成片");
    }
    // 整轴固定时长校验（渲染期语义）：逐剪辑校验上下文规则 + end 不越界
    await this.validateClips(timeline, tracks, clips);

    const payload: TimelineRenderTaskPayload = {
      v: 1,
      timelineId,
      projectId: timeline.projectId,
      version: timeline.version,
      fps: timeline.fps,
      width: timeline.width,
      height: timeline.height,
      clips: clips
        .slice()
        .sort((a, b) => clipSortKey(a, tracks) - clipSortKey(b, tracks))
        .map((c) => ({
          clipId: c.id,
          trackId: c.trackId,
          trackType: tracks.find((t) => t.id === c.trackId)?.type ?? "video",
          assetId: c.assetId,
          shotId: c.shotId,
          startTime: c.startTime,
          duration: c.duration,
          sourceStartTime: c.sourceStartTime,
          sourceDuration: c.sourceDuration,
        })),
    };

    const taskId = randomId("ptk");
    const now = new Date();
    let updated: ProductionTimeline;
    // 同一事务：状态切换 + 任务落库（同连接原子提交，避免「任务已入队但状态停留」的一半状态）
    await this.deps.repo.transaction(async (tx) => {
      updated = (await tx.updateTimeline(timelineId, { status: nextStatus })) ?? (await tx.getTimeline(timelineId))!;
      this.deps.db
        .insert(tasksTable)
        .values({
          id: taskId,
          projectId: timeline.projectId,
          userId,
          kind: "timeline_render",
          status: "queued",
          payload: JSON.stringify(payload),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    return {
      task: {
        id: taskId,
        projectId: timeline.projectId,
        userId,
        kind: "timeline_render",
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
      timeline: updated!,
    };
  }

  /** 逐剪辑上下文校验（validateClipAgainstContext 已含：资产类型匹配/同项目/end 不越轴/资产必绑） */
  private async validateClips(
    timeline: ProductionTimeline,
    tracks: TimelineTrack[],
    clips: TimelineClip[],
  ): Promise<void> {
    const trackById = new Map(tracks.map((t) => [t.id, t] as const));
    for (const clip of clips) {
      const track = trackById.get(clip.trackId);
      if (!track) {
        throw validationError(`剪辑 ${clip.id} 关联的轨道不存在`);
      }
      const asset =
        clip.assetId === undefined ? null : await this.deps.repo.getAsset(clip.assetId);
      if (clip.assetId !== undefined && !asset) {
        throw notFoundError("资产");
      }
      const shot = clip.shotId === undefined ? null : await this.deps.repo.getShot(clip.shotId);
      if (clip.shotId !== undefined && !shot) {
        throw notFoundError("镜头");
      }
      validateClipAgainstContext(
        { assetId: clip.assetId, shotId: clip.shotId, startTime: clip.startTime, duration: clip.duration },
        {
          timeline: { duration: timeline.duration, projectId: timeline.projectId },
          track: { type: track.type },
          asset: asset ? { type: asset.type, projectId: asset.projectId } : null,
          shot: shot ? { projectId: shot.projectId } : null,
        },
      );
    }
  }
}

/** 快照排序键：track.order * 大数 + clip.order（同轨剪辑按序展开） */
function clipSortKey(clip: TimelineClip, tracks: TimelineTrack[]): number {
  const trackOrder = tracks.find((t) => t.id === clip.trackId)?.order ?? 0;
  return trackOrder * 1_000_000 + clip.order;
}
