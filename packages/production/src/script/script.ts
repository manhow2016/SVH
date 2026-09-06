/**
 * Script 领域规则：状态枚举、校验与状态机（文档 §6.2）。
 */
import type { ScriptStatus } from "./script-types";
import { validationError } from "../errors";

export const SCRIPT_STATUSES: readonly ScriptStatus[] = ["draft", "reviewing", "approved"];

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 500_000;

export function isScriptStatus(v: unknown): v is ScriptStatus {
  return typeof v === "string" && (SCRIPT_STATUSES as readonly string[]).includes(v);
}

/** 校验并规范剧本标题 */
export function validateScriptTitle(title: unknown): string {
  if (typeof title !== "string") {
    throw validationError("剧本标题必须为字符串");
  }
  const trimmed = title.trim();
  if (trimmed === "") {
    throw validationError("剧本标题不能为空");
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw validationError(`剧本标题不能超过 ${MAX_TITLE_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 校验并规范剧本正文 */
export function validateScriptContent(content: unknown): string {
  if (typeof content !== "string") {
    throw validationError("剧本内容必须为字符串");
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw validationError(`剧本内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`);
  }
  return content;
}

/**
 * 剧本状态机：draft → reviewing → approved；审核通过后可再退回 reviewing/draft。
 */
const SCRIPT_TRANSITIONS: Readonly<Record<ScriptStatus, readonly ScriptStatus[]>> = {
  draft: ["reviewing"],
  reviewing: ["approved", "draft"],
  approved: ["reviewing", "draft"],
};

export function canTransitionScriptStatus(from: ScriptStatus, to: ScriptStatus): boolean {
  return (SCRIPT_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** 内容变更：版本 +1（调用方在确有内容变更时使用） */
export function bumpScriptVersion(version: number): number {
  return version + 1;
}
