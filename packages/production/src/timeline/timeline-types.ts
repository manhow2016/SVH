/**
 * Production Timeline 领域类型（V0.3 文档 §四-1、§五）。
 *
 * Timeline 是成片组织的正式领域模型：Project → Timeline → Track → Clip。
 * Clip 引用既有生产资产（production_assets）与镜头（production_shots），
 * 不重复设计资产体系；subtitle / overlay 轨道在第一阶段仅预留类型位。
 */

/** Timeline 生命周期状态（文档 §1.1） */
export type TimelineStatus = "draft" | "editing" | "ready" | "rendering" | "completed" | "failed";

/**
 * 轨道类型（文档 §1.2）。
 * 第一阶段仅实现 video / audio；subtitle / overlay 必须保留扩展位。
 */
export type TimelineTrackType = "video" | "audio" | "subtitle" | "overlay";

/** Timeline 渲染目标（fps / 宽高）；Auto Timeline 与 Render 阶段按此解析 */
export interface TimelineRenderTarget {
  fps: number;
  width: number;
  height: number;
}

export interface ProductionTimeline {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  /** 总时长（秒），由各轨道 Clip 覆盖范围决定，>= 0 */
  duration: number;
  fps: number;
  width: number;
  height: number;
  status: TimelineStatus;
  /** 编辑版本号：每次内容变更 +1（渲染/自动生成也递增） */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TimelineTrack {
  id: string;
  timelineId: string;
  type: TimelineTrackType;
  name: string;
  /** 轨道纵向顺序（0 起，升序） */
  order: number;
  muted?: boolean;
  locked?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TimelineClip {
  id: string;
  timelineId: string;
  trackId: string;
  /** 关联生产资产（production_assets.id；video 轨道须为 video 资产，audio 轨道须为 audio 资产） */
  assetId?: string;
  /** 关联镜头（production_shots.id；便于回查来源） */
  shotId?: string;
  /** 在时间轴上的起点（秒），>= 0 */
  startTime: number;
  /** 时间轴上占据的长度（秒），> 0 */
  duration: number;
  /** 源素材内起始偏移（秒，如裁剪；>= 0） */
  sourceStartTime?: number;
  /** 源素材内截取长度（秒，> 0） */
  sourceDuration?: number;
  /** 轨道内顺序（同轨剪辑依此排序） */
  order: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ---- 创建输入（id / 时间戳由 Service 与仓储生成） ----

export interface CreateTimelineInput {
  projectId: string;
  name: string;
  description?: string;
  /** 默认 24（DEFAULT_TIMELINE_FPS） */
  fps?: number;
  /** 默认 1920（DEFAULT_TIMELINE_WIDTH） */
  width?: number;
  /** 默认 1080（DEFAULT_TIMELINE_HEIGHT） */
  height?: number;
}

export interface CreateTimelineTrackInput {
  timelineId: string;
  type: TimelineTrackType;
  name: string;
  /** 默认追加到末尾（由 Service 取当前最大 order + 1） */
  order?: number;
  muted?: boolean;
  locked?: boolean;
}

export interface CreateTimelineClipInput {
  timelineId: string;
  trackId: string;
  assetId?: string;
  shotId?: string;
  startTime: number;
  duration: number;
  sourceStartTime?: number;
  sourceDuration?: number;
  /** 默认追加到轨道末尾（由 Service 取当前最大 order + 1） */
  order?: number;
  metadata?: Record<string, unknown>;
}

// ---- 更新输入 ----

export type UpdateTimelineInput = Partial<
  Pick<ProductionTimeline, "name" | "description" | "duration" | "fps" | "width" | "height" | "status">
>;

export type UpdateTimelineTrackInput = Partial<
  Pick<TimelineTrack, "type" | "name" | "order" | "muted" | "locked">
>;

/**
 * 更新输入：关联列允许显式置空（null = 解除绑定；undefined = 字段不动），
 * 其余标量列 undefined 即不动。
 */
export type UpdateTimelineClipInput = Partial<{
  assetId: string | null;
  shotId: string | null;
  startTime: number;
  duration: number;
  sourceStartTime: number;
  sourceDuration: number;
  order: number;
  metadata: Record<string, unknown>;
}>;
