/**
 * Storyboard 领域规则：校验与状态（文档 §6.5）。
 */
import type { StoryboardStatus } from "./storyboard-types";
import { validationError } from "../errors";

export const STORYBOARD_STATUSES: readonly StoryboardStatus[] = ["draft", "approved"];

const MAX_TEXT_LENGTH = 2000;

export function isStoryboardStatus(v: unknown): v is StoryboardStatus {
  return typeof v === "string" && (STORYBOARD_STATUSES as readonly string[]).includes(v);
}

/** 校验分镜时长（正数，向上取整为秒） */
export function validateStoryboardDuration(duration: unknown): number {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw validationError("分镜时长必须为正数（秒）");
  }
  return Math.round(duration);
}

/** 校验景别/运镜类型（非空字符串，限长） */
export function validateShotType(shotType: unknown): string {
  if (typeof shotType !== "string") {
    throw validationError("景别/运镜类型必须为字符串");
  }
  const trimmed = shotType.trim();
  if (trimmed === "") {
    throw validationError("景别/运镜类型不能为空");
  }
  if (trimmed.length > 100) {
    throw validationError("景别/运镜类型不能超过 100 个字符");
  }
  return trimmed;
}

/** 校验描述（非空，限长） */
export function validateStoryboardDescription(description: unknown): string {
  if (typeof description !== "string") {
    throw validationError("分镜描述必须为字符串");
  }
  const trimmed = description.trim();
  if (trimmed === "") {
    throw validationError("分镜描述不能为空");
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw validationError(`分镜描述不能超过 ${MAX_TEXT_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 规范可选字符串字段（prompts / cameraMovement） */
export function normalizeOptionalPrompt(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw validationError(`${field} 必须为字符串`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_TEXT_LENGTH);
}
