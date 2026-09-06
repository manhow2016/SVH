/**
 * Shot 领域规则：校验与状态机（文档 §6.6）。
 */
import type { ShotStatus } from "./shot-types";
import { conflictError, validationError } from "../errors";

export const SHOT_STATUSES: readonly ShotStatus[] = ["pending", "generating", "ready", "failed"];

const MAX_TEXT_LENGTH = 2000;

export function isShotStatus(v: unknown): v is ShotStatus {
  return typeof v === "string" && (SHOT_STATUSES as readonly string[]).includes(v);
}

/** 校验镜头时长（正数，向上取整为秒） */
export function validateShotDuration(duration: unknown): number {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw validationError("镜头时长必须为正数（秒）");
  }
  return Math.round(duration);
}

/** 规范可选字符串字段 */
export function normalizeOptionalShotText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw validationError(`${field} 必须为字符串`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_TEXT_LENGTH);
}

/**
 * 镜头状态机：pending → generating → ready | failed；failed 可重置回 pending 重试。
 */
const SHOT_TRANSITIONS: Readonly<Record<ShotStatus, readonly ShotStatus[]>> = {
  pending: ["generating"],
  generating: ["ready", "failed"],
  ready: ["generating"],
  failed: ["pending"],
};

export function canTransitionShotStatus(from: ShotStatus, to: ShotStatus): boolean {
  return (SHOT_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** 应用镜头状态跳转（同状态为 no-op；非法跳转抛 CONFLICT） */
export function applyShotStatus(from: ShotStatus, to: ShotStatus): ShotStatus {
  if (from === to) {
    return from;
  }
  if (!canTransitionShotStatus(from, to)) {
    throw conflictError(`镜头状态不允许从 ${from} 变更到 ${to}`);
  }
  return to;
}

/** 校验同一分镜下镜头总时长不超过分镜时长 */
export function assertShotsWithinStoryboardDuration(
  summaryShotDurations: number,
  storyboardDuration: number,
): void {
  if (summaryShotDurations > storyboardDuration) {
    throw validationError(
      `分镜下镜头总时长（${summaryShotDurations}s）不能超过分镜时长（${storyboardDuration}s）`,
    );
  }
}
