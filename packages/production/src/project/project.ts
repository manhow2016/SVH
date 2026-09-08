/**
 * Project 领域规则：类型/状态枚举、校验与状态机（文档 §6.1）。
 */
import type { ProductionProjectSettings, ProjectStatus, ProjectType } from "./project-types";
import { normalizeVisualStyleProfile } from "../style/visual-style-types";
import { conflictError, validationError } from "../errors";

export const PROJECT_TYPES: readonly ProjectType[] = [
  "short_video",
  "short_drama",
  "animation",
  "advertisement",
];

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  "draft",
  "planning",
  "producing",
  "completed",
  "archived",
];

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;

export function isProjectType(v: unknown): v is ProjectType {
  return typeof v === "string" && (PROJECT_TYPES as readonly string[]).includes(v);
}

export function isProjectStatus(v: unknown): v is ProjectStatus {
  return typeof v === "string" && (PROJECT_STATUSES as readonly string[]).includes(v);
}

/** 校验并规范项目描述（可选，限长） */
export function validateProjectDescription(description: unknown): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== "string") {
    throw validationError("项目描述必须为字符串");
  }
  const trimmed = description.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw validationError(`项目描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 校验项目名称：非空、trim、长度上限 */
export function validateProjectName(name: unknown): string {
  if (typeof name !== "string") {
    throw validationError("项目名称必须为字符串");
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw validationError("项目名称不能为空");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw validationError(`项目名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 校验并规范化项目设置：只保留已知字段，数值做范围约束（输入允许任意结构，来自工具/AI 传入） */
export function normalizeProjectSettings(input?: unknown): ProductionProjectSettings {
  const settings: ProductionProjectSettings = {};
  if (input === undefined) return settings;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("settings 必须为对象");
  }
  const raw = input as ProductionProjectSettings;
  if (raw.duration != null) {
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration <= 0) {
      throw validationError("目标时长必须为正数（秒）");
    }
    settings.duration = Math.round(raw.duration);
  }
  if (raw.style !== undefined) {
    if (typeof raw.style !== "string") {
      throw validationError("风格必须为字符串");
    }
    const style = raw.style.trim();
    if (style !== "") {
      settings.style = style.slice(0, 100);
    }
  }
  if (raw.visualStyle !== undefined) {
    const visualStyle = normalizeVisualStyleProfile(raw.visualStyle);
    if (visualStyle !== undefined) {
      settings.visualStyle = visualStyle;
    }
  }
  if (raw.generation !== undefined) {
    if (typeof raw.generation !== "object" || raw.generation === null || Array.isArray(raw.generation)) {
      throw validationError("generation 配置必须为对象");
    }
    settings.generation = raw.generation as Record<string, unknown>;
  }
  return settings;
}

/**
 * 项目状态机（允许的跳转）：
 * draft → planning → producing → completed；任意非 archived 状态可归档；
 * archived 可重新打开为 draft。
 */
const PROJECT_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  draft: ["planning", "archived"],
  planning: ["producing", "draft", "archived"],
  producing: ["completed", "archived"],
  completed: ["archived"],
  archived: ["draft"],
};

export function canTransitionProjectStatus(from: ProjectStatus, to: ProjectStatus): boolean {
  return (PROJECT_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** 应用状态跳转（同状态为 no-op；非法跳转抛 CONFLICT） */
export function applyProjectStatus(from: ProjectStatus, to: ProjectStatus): ProjectStatus {
  if (from === to) {
    return from;
  }
  if (!canTransitionProjectStatus(from, to)) {
    throw conflictError(`项目状态不允许从 ${from} 变更到 ${to}`);
  }
  return to;
}
