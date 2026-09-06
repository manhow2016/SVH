/**
 * Asset 领域规则：类型校验、名称、URL 与生成信息（文档 §7）。
 */
import type { AssetGeneration, AssetType } from "./asset-types";
import { validationError } from "../errors";

export const ASSET_TYPES: readonly AssetType[] = ["image", "video", "audio", "document", "subtitle", "reference"];

const MAX_NAME_LENGTH = 200;

export function isAssetType(v: unknown): v is AssetType {
  return typeof v === "string" && (ASSET_TYPES as readonly string[]).includes(v);
}

/** 校验并规范资产名称 */
export function validateAssetName(name: unknown): string {
  if (typeof name !== "string") {
    throw validationError("资产名称必须为字符串");
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw validationError("资产名称不能为空");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw validationError(`资产名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 校验 URL（可选，但提供时必须为 http/https 绝对地址） */
export function validateAssetUrl(url: unknown): string | undefined {
  if (url === undefined) return undefined;
  if (typeof url !== "string") {
    throw validationError("资产 URL 必须为字符串");
  }
  const trimmed = url.trim();
  if (trimmed === "") return undefined;
  if (!/^https?:\/\//.test(trimmed)) {
    throw validationError("资产 URL 必须为 http(s) 绝对地址");
  }
  return trimmed.slice(0, 2048);
}

/** 校验工作区相对路径（可选，禁止绝对路径与 .. 逃逸） */
export function validateWorkspacePath(workspacePath: unknown): string | undefined {
  if (workspacePath === undefined) return undefined;
  if (typeof workspacePath !== "string") {
    throw validationError("工作区路径必须为字符串");
  }
  const trimmed = workspacePath.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
    throw validationError("工作区路径必须为相对路径且禁止 .. 逃逸");
  }
  return trimmed.slice(0, 500);
}

/** 校验生成信息：可选，但若提供必须含 providerId 且为字符串 */
export function validateAssetGeneration(generation?: AssetGeneration): AssetGeneration | undefined {
  if (generation === undefined) return undefined;
  if (typeof generation !== "object" || generation === null) {
    throw validationError("generation 必须为对象");
  }
  if (typeof generation.providerId !== "string" || generation.providerId.trim() === "") {
    throw validationError("generation.providerId 不能为空");
  }
  const out: AssetGeneration = { providerId: generation.providerId.trim() };
  if (generation.modelId !== undefined) {
    if (typeof generation.modelId !== "string") {
      throw validationError("generation.modelId 必须为字符串");
    }
    out.modelId = generation.modelId;
  }
  if (generation.prompt !== undefined) {
    if (typeof generation.prompt !== "string") {
      throw validationError("generation.prompt 必须为字符串");
    }
    out.prompt = generation.prompt;
  }
  if (generation.taskId !== undefined) {
    if (typeof generation.taskId !== "string") {
      throw validationError("generation.taskId 必须为字符串");
    }
    out.taskId = generation.taskId;
  }
  return out;
}

/** 规范可选 metadata（任意对象） */
export function normalizeAssetMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw validationError("metadata 必须为对象");
  }
  return metadata as Record<string, unknown>;
}
