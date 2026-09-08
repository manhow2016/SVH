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

  // ---- 认证 / 会员（文档 §40 错误码） ----
  UNAUTHORIZED: (message = "请先登录") => new ServerError("UNAUTHORIZED", message, 401),
  FORBIDDEN: (message = "无权访问") => new ServerError("FORBIDDEN", message, 403),
  USER_DISABLED: () => new ServerError("USER_DISABLED", "账号已被禁用，请联系管理员", 403),
  INVALID_CREDENTIALS: () => new ServerError("INVALID_CREDENTIALS", "用户名或密码错误", 401),
  USERNAME_TAKEN: () => new ServerError("USERNAME_TAKEN", "用户名已被使用", 409),
  EMAIL_TAKEN: () => new ServerError("EMAIL_TAKEN", "邮箱已被使用", 409),
  WEAK_PASSWORD: () =>
    new ServerError("WEAK_PASSWORD", "密码至少 8 位，且包含字母和数字", 400),
  FEATURE_NOT_AVAILABLE: (message = "当前会员等级暂不支持此功能") =>
    new ServerError("FEATURE_NOT_AVAILABLE", message, 403),
  SUBSCRIPTION_EXPIRED: () =>
    new ServerError("SUBSCRIPTION_EXPIRED", "会员已过期，请续费", 403),
  PLAN_NOT_AVAILABLE: (message = "套餐不存在或已下架") =>
    new ServerError("PLAN_NOT_AVAILABLE", message, 400),
  PROMOTION_NOT_AVAILABLE: (message = "活动不可用") =>
    new ServerError("PROMOTION_NOT_AVAILABLE", message, 404),
  RESOURCE_LIMIT_EXCEEDED: (message = "已达到当前会员等级的资源上限") =>
    new ServerError("RESOURCE_LIMIT_EXCEEDED", message, 403),
} as const;

import { ProductionError } from "@svh/production";

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
  // 生产领域错误（@svh/production ProductionError）：映射到 HTTP 语义
  if (err instanceof ProductionError) {
    const status = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 }[err.code] ?? 500;
    return { status, code: err.code, message: err.message };
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
