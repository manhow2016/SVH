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
  models: Record<ModelType, string[]>;
  /** 是否固定端点（固定端点 = 使用目录内 baseUrl；否则按用户配置的 baseUrl 调用） */
  fixedEndpoint: boolean;
}

export interface ProviderApiKey {
  apiKey: string;
  baseUrl?: string;
}

export interface ModelTypeConfig {
  provider: string;
  model: string;
}

/** 模型设置（ApiKey 不回传明文，只读回 hasApiKey） */
export interface PublicModelSettings {
  providers: Array<{ id: string; baseUrl?: string; hasApiKey: boolean }>;
  models: Record<ModelType, ModelTypeConfig>;
}

export interface ModelCatalog {
  providers: ModelProviderMeta[];
  types: ModelTypeMeta[];
}

export interface SettingsView {
  catalog: ModelCatalog;
  models: PublicModelSettings;
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
