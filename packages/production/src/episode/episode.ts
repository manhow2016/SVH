/**
 * Episode 领域校验（短剧多集，V0.3）。
 *
 * 纯函数：集名/描述/集号的字段级校验，与既有实体（scene/storyboard）同纪律。
 */
import { validationError } from "../errors";

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

/** 校验并规范集名（非空，<= 200） */
export function validateEpisodeName(name: unknown): string {
  if (typeof name !== "string") {
    throw validationError("集名必须为字符串");
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw validationError("集名不能为空");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw validationError(`集名不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 规范可选集描述（空串转 undefined；截断到 2000） */
export function validateEpisodeDescription(description: unknown): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== "string") {
    throw validationError("集描述必须为字符串");
  }
  const trimmed = description.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_DESCRIPTION_LENGTH);
}

/** 校验集号（规则：order >= 1 整数，集号从 1 起） */
export function validateEpisodeOrder(order: unknown): number {
  if (typeof order !== "number" || !Number.isFinite(order) || order < 1 || !Number.isInteger(order)) {
    throw validationError("集号必须为 >= 1 的整数");
  }
  return order;
}

/** 缺省集名：第 N 集 */
export function defaultEpisodeName(order: number): string {
  return `第 ${order} 集`;
}
