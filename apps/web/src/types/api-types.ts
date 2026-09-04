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

export interface PublicLLMSettings {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
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
