/**
 * Web 侧 API 类型（与 server / shared 契约保持一致）。
 *
 * Workspace / FileEntry 定义于 @svh/workspace（server 包），
 * web 不依赖该包，此处为纯类型镜像；Session / SessionMessage 复用 @svh/shared。
 */

import type { Session, SessionMessage } from "@svh/shared";

export type { Session, SessionMessage };

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  /** 目录是否为空（仅 type=directory 时有意义；用于隐藏空目录展开箭头） */
  isEmpty?: boolean;
}

export interface FileContent {
  path: string;
  content: string;
}

/** 模型类型（V2 供应商体系：文本/图片/视频/音频） */
export type ModelType = "text" | "image" | "video" | "audio";

export interface ModelTypeMeta {
  code: ModelType;
  label: string;
  description: string;
}

export interface ModelProviderMeta {
  id: string;
  name: string;
  baseUrl: string;
  /** 是否固定端点（固定端点 = 使用目录内 baseUrl） */
  fixedEndpoint: boolean;
}

/** 可用模型（管理员后台维护；用户视角仅启用项） */
export interface AvailableModel {
  id: string;
  modelName: string;
  type: ModelType;
  displayName: string;
}

/** 供应商 + 设置视图：API Key 不回传明文（仅 hasApiKey），附该供应商可用模型列表 */
export interface ProviderSettingsView extends ModelProviderMeta {
  hasApiKey: boolean;
  models: AvailableModel[];
}

export interface ModelCatalog {
  providers: ModelProviderMeta[];
  types: ModelTypeMeta[];
}

export interface SettingsView {
  catalog: ModelCatalog;
  providers: ProviderSettingsView[];
  /** 用户启用的模型 id 列表（null = 全部启用） */
  enabledModels: string[] | null;
}

/** 供应商 API Key 验证状态（no_key 未配置 / invalid_key 无效 / network 网络异常 / unsupported 端点不支持） */
export type ProviderVerifyStatus = "ok" | "no_key" | "invalid_key" | "network" | "unsupported";

/** 供应商 API Key 验证结果（POST /api/settings/verify） */
export interface ProviderVerifyResult {
  ok: boolean;
  status: ProviderVerifyStatus;
  message?: string;
}

/** 技能参数类型（与 /api/skills 返回一致） */
export type SkillParamType = "text" | "textarea" | "number" | "select";
export interface SkillParamDef {
  key: string;
  label: string;
  type: SkillParamType;
  primary?: boolean;
  required?: boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  default?: string | number;
}
export type SkillResultKind = "text" | "image" | "video" | "audio";
export interface SkillDefinitionView {
  id: string;
  name: string;
  description: string;
  modelTypes: string[];
  params: SkillParamDef[];
  resultKind: SkillResultKind;
}
export interface SkillMessageMeta {
  skillId: string;
  skillName: string;
  params: Record<string, string | number>;
  modelName: string;
  resultKind: SkillResultKind;
}

/** AgentEvent 的 web 镜像（与 packages/core 一致，仅类型） */
export type AgentEvent =
  | { type: "run.started" }
  | { type: "message.started"; messageId: string }
  | { type: "message.delta"; messageId: string; content: string }
  | { type: "message.completed"; messageId: string }
  | { type: "tool.called"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool.completed"; toolCallId: string; toolName: string; output: unknown }
  | { type: "workspace.changed"; paths: string[] }
  | { type: "run.completed" }
  | { type: "run.error"; error: string };
