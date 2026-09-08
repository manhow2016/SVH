/**
 * Generation Plan 类型（V0.3 Phase 6，实施文档 §32）。
 *
 * 把「一批待生成镜头」抽象为一个计划：每个计划项对应一个镜头的一次生成
 * （image 或 video），带优先级 / 依赖 / 供应商偏好 / 状态。
 * 计划只描述「要生成什么」，执行由 server 编排器交给既有任务队列完成。
 */
import type { ProductionShot } from "../shot/shot-types";

export type GenerationPlanType = "image" | "video";
export type GenerationPlanItemStatus = "pending" | "enqueued" | "completed" | "failed" | "cancelled";

export interface GenerationPlanItem {
  /** 唯一项 id（默认 `${shotId}:${type}`） */
  id: string;
  shotId: string;
  storyboardId?: string;
  type: GenerationPlanType;
  /** 优先级（越小越优先；默认取镜头 order） */
  priority: number;
  /** 依赖项 id（如 video 依赖同镜头的 image） */
  dependencies: string[];
  /** 供应商偏好（providerId 列表，命中即优先选用） */
  providerPreference?: string[];
  status: GenerationPlanItemStatus;
}

export interface GenerationPlanScope {
  sceneId?: string;
  storyboardId?: string;
  shotIds?: string[];
}

export interface GenerationPlan {
  projectId: string;
  scope: GenerationPlanScope;
  items: GenerationPlanItem[];
}

export type { ProductionShot };

/** 计划项 id */
export function planItemId(shotId: string, type: GenerationPlanType): string {
  return `${shotId}:${type}`;
}
