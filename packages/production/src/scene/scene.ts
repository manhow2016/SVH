/**
 * Scene 领域规则：校验、顺序与出场角色规范化（文档 §6.4）。
 */
import type { ProductionScene } from "./scene-types";
import { validationError } from "../errors";

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

/** 校验并规范场景名称 */
export function validateSceneName(name: unknown): string {
  if (typeof name !== "string") {
    throw validationError("场景名称必须为字符串");
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw validationError("场景名称不能为空");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw validationError(`场景名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 校验并规范场景描述 */
export function validateSceneDescription(description: unknown): string {
  if (typeof description !== "string") {
    throw validationError("场景描述必须为字符串");
  }
  const trimmed = description.trim();
  if (trimmed === "") {
    throw validationError("场景描述不能为空");
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw validationError(`场景描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 规范可选字符串字段（location/time/scriptId） */
export function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw validationError(`${field} 必须为字符串`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 500);
}

/** 规范出场角色列表：字符串数组、trim、去空、长度上限 */
export function normalizeCharacters(characters?: unknown): string[] {
  if (characters === undefined) return [];
  if (!Array.isArray(characters)) {
    throw validationError("出场角色必须为字符串数组");
  }
  const result: string[] = [];
  for (const item of characters) {
    if (typeof item !== "string") {
      throw validationError("出场角色必须为字符串数组");
    }
    const trimmed = item.trim();
    if (trimmed !== "") {
      result.push(trimmed.slice(0, 100));
    }
  }
  return result;
}

/** 校验场景顺序（非负整数，允许重复由 Service 层排重） */
export function validateSceneOrder(order: unknown, field = "order"): number {
  if (typeof order !== "number" || !Number.isInteger(order) || order < 0) {
    throw validationError(`${field} 必须为非负整数`);
  }
  return order;
}

/** 计算下一个顺序号：现有顺序最大值的下一个（无则 0） */
export function nextOrder(orders: readonly number[]): number {
  if (orders.length === 0) return 0;
  return Math.max(...orders) + 1;
}

/** 按 order 排序（稳定排序，order 相同按 id） */
export function sortByOrder<T extends Pick<ProductionScene, "order"> & { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
