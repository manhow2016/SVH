import { WorkspaceError } from "@svh/workspace";
import { ToolError } from "@svh/tools";
import type { ErrorResponse } from "@svh/shared";

/** 服务层统一错误（文档 §47） */
export class ServerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "ServerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const ERRORS = {
  WORKSPACE_NOT_FOUND: () => new ServerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404),
  SESSION_NOT_FOUND: () => new ServerError("SESSION_NOT_FOUND", "Session not found", 404),
  SESSION_RUNNING: () =>
    new ServerError("SESSION_ALREADY_RUNNING", "Session is already running", 409),
  INVALID_INPUT: (message: string) => new ServerError("INVALID_INPUT", message, 400),
  INVALID_WORKSPACE_PATH: (message = "Invalid workspace path") =>
    new ServerError("INVALID_WORKSPACE_PATH", message, 400),
  INTERNAL: () => new ServerError("INTERNAL_ERROR", "Internal server error", 500),
} as const;

/** 将任意异常规范化成 { status, code, message, details } */
export function normalizeError(err: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (err instanceof ServerError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof WorkspaceError) {
    if (err.code === "WORKSPACE_NOT_FOUND") {
      return { status: 404, code: err.code, message: err.message };
    }
    return { status: 400, code: err.code, message: err.message };
  }
  if (err instanceof ToolError) {
    return { status: 400, code: err.code, message: err.message };
  }
  // 未知错误：不泄漏堆栈
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

export function toErrorResponse(err: unknown): ErrorResponse {
  const { code, message, details } = normalizeError(err);
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}
