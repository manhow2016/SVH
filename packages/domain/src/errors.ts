/**
 * 统一错误体系
 *
 * 对应技术文档第 66 条：**禁止向用户暴露 500 Internal Server Error / AxiosError /
 * ProviderError 这类技术错误**。技术错误必须记录到日志，返回给用户的必须是
 * 「发生了什么 + 可能原因 + 下一步怎么做」。
 *
 * 因此每个错误都携带两份信息：
 * - 技术信息（`code` / `message` / `details`）：进日志、进链路追踪
 * - 用户信息（`userMessage` / `suggestions` / `actions`）：进 Agent UI
 */
import { z } from 'zod';

/** 错误码全集 */
export const ERROR_CODES = [
  // 通用
  'INTERNAL_ERROR',
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  // 权限与配额
  'SKILL_TIER_REQUIRED',
  'QUOTA_EXCEEDED',
  'CONFIRMATION_REQUIRED',
  // 模型层
  'PROVIDER_UNAVAILABLE',
  'MODEL_NOT_CONFIGURED',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_BAD_OUTPUT',
  'MODEL_CONTENT_REJECTED',
  // 任务层
  'TASK_NOT_FOUND',
  'TASK_NOT_CANCELLABLE',
  'TASK_TIMEOUT',
  // 资产与内容
  'ASSET_NOT_FOUND',
  'ASSET_IN_USE',
  'ASSET_VERSION_NOT_FOUND',
  'CONTENT_NOT_FOUND',
  'WORKFLOW_INVALID',
  'WORKFLOW_RUN_NOT_FOUND',
  // 技能
  'SKILL_NOT_FOUND',
  'SKILL_EXECUTION_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 与「模型服务商」相关的错误码集合。
 *
 * Model Router 用它判断「换一个模型是否可能成功」：
 * 这类错误通常是 Provider 侧的临时问题，切换备用模型比原模型重试更有效。
 */
export const PROVIDER_FAILURE_CODES: readonly ErrorCode[] = [
  'PROVIDER_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_BAD_OUTPUT',
  'MODEL_CONTENT_REJECTED',
  'MODEL_NOT_CONFIGURED',
];

/** 判断一个错误码是否属于模型服务商类错误 */
export function isProviderFailureCode(code: ErrorCode): boolean {
  return PROVIDER_FAILURE_CODES.includes(code);
}

/**
 * 错误码 → HTTP 状态码。
 * 使用 `satisfies` 保证新增错误码时**必须**同时补充映射，否则编译失败。
 */
export const HTTP_STATUS_BY_CODE = {
  INTERNAL_ERROR: 500,
  VALIDATION_FAILED: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SKILL_TIER_REQUIRED: 402,
  QUOTA_EXCEEDED: 429,
  CONFIRMATION_REQUIRED: 428,
  PROVIDER_UNAVAILABLE: 503,
  MODEL_NOT_CONFIGURED: 424,
  MODEL_RATE_LIMITED: 429,
  MODEL_TIMEOUT: 504,
  MODEL_BAD_OUTPUT: 502,
  MODEL_CONTENT_REJECTED: 422,
  TASK_NOT_FOUND: 404,
  TASK_NOT_CANCELLABLE: 409,
  TASK_TIMEOUT: 504,
  ASSET_NOT_FOUND: 404,
  ASSET_IN_USE: 409,
  ASSET_VERSION_NOT_FOUND: 404,
  CONTENT_NOT_FOUND: 404,
  WORKFLOW_INVALID: 422,
  WORKFLOW_RUN_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  SKILL_EXECUTION_FAILED: 500,
} as const satisfies Record<ErrorCode, number>;

/**
 * 错误码 → 默认的用户可理解文案。
 * 同样使用 `satisfies` 强制补全。
 */
export const USER_MESSAGE_BY_CODE = {
  INTERNAL_ERROR: '系统出现了一点问题，请稍后重试。',
  VALIDATION_FAILED: '提交的内容有问题，请检查后重试。',
  BAD_REQUEST: '请求无法处理，请检查后重试。',
  UNAUTHORIZED: '登录状态已失效，请重新登录。',
  FORBIDDEN: '你没有执行该操作的权限。',
  NOT_FOUND: '没有找到对应的内容。',
  CONFLICT: '当前状态不允许执行该操作。',
  RATE_LIMITED: '操作过于频繁，请稍后再试。',
  SKILL_TIER_REQUIRED: '该功能需要更高的会员等级。',
  QUOTA_EXCEEDED: '当前用量已超出限制。',
  CONFIRMATION_REQUIRED: '该操作影响较大，需要你确认后才会执行。',
  PROVIDER_UNAVAILABLE: '模型服务暂时不可用。',
  MODEL_NOT_CONFIGURED: '还没有配置可用的模型，请先在设置中添加模型 API。',
  MODEL_RATE_LIMITED: '模型调用过于频繁，请稍后再试。',
  MODEL_TIMEOUT: '模型响应超时，请重试或更换模型。',
  MODEL_BAD_OUTPUT: '模型返回的内容无法解析，请重试。',
  MODEL_CONTENT_REJECTED: '内容未通过模型的安全校验，请调整描述后重试。',
  TASK_NOT_FOUND: '没有找到对应的任务。',
  TASK_NOT_CANCELLABLE: '该任务已经结束，无法取消。',
  TASK_TIMEOUT: '任务执行超时，请重试。',
  ASSET_NOT_FOUND: '没有找到对应的资产。',
  ASSET_IN_USE: '该资产正在被其他内容引用，无法直接删除。',
  ASSET_VERSION_NOT_FOUND: '没有找到对应的历史版本。',
  CONTENT_NOT_FOUND: '没有找到对应的内容。',
  WORKFLOW_INVALID: '制作流程配置有误，无法执行。',
  WORKFLOW_RUN_NOT_FOUND: '没有找到对应的制作流程记录。',
  SKILL_NOT_FOUND: '没有找到对应的技能。',
  SKILL_EXECUTION_FAILED: '技能执行失败，请重试。',
} as const satisfies Record<ErrorCode, string>;

/** 错误码 → 建议的处置方式（面向用户） */
export const SUGGESTIONS_BY_CODE: Partial<Record<ErrorCode, string[]>> = {
  PROVIDER_UNAVAILABLE: ['稍后重试', '更换其他模型', '检查模型 API 配置'],
  MODEL_NOT_CONFIGURED: ['前往设置添加模型 API', '使用系统默认模型'],
  MODEL_TIMEOUT: ['重试', '更换响应更快的模型'],
  MODEL_RATE_LIMITED: ['稍后重试', '降低并发或更换 Provider'],
  MODEL_BAD_OUTPUT: ['重试', '简化需求描述'],
  MODEL_CONTENT_REJECTED: ['调整描述用词后重试'],
  SKILL_TIER_REQUIRED: ['升级会员', '改用基础技能'],
  QUOTA_EXCEEDED: ['升级会员', '减少本次生成数量'],
  CONFIRMATION_REQUIRED: ['确认后执行', '取消'],
  ASSET_IN_USE: ['先解除引用', '确认后强制删除'],
  WORKFLOW_INVALID: ['让 Agent 重新规划制作流程'],
  TASK_TIMEOUT: ['重试', '拆分为更小的任务'],
};

/** 错误上下文的可序列化结构 */
export interface SvhErrorContext {
  /** 关联的资源 id，便于日志检索 */
  taskId?: string;
  projectId?: string;
  contentId?: string;
  assetId?: string;
  providerId?: string;
  modelId?: string;
  skillId?: string;
  [key: string]: unknown;
}

/** 构造错误时的选项 */
export interface SvhErrorOptions {
  /** 覆盖默认的用户文案 */
  userMessage?: string;
  /** 覆盖默认的建议 */
  suggestions?: string[];
  /** 原始错误（仅进日志） */
  cause?: unknown;
  /** 结构化上下文 */
  context?: SvhErrorContext;
  /** 是否可重试：决定 Agent 是否自动重试 */
  retryable?: boolean;
}

/**
 * SVH 统一错误基类。
 *
 * 约定：所有跨模块抛出的错误都必须是 SvhError 的子类，
 * 这样 API 层可以统一序列化为面向用户的错误响应。
 */
export class SvhError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly suggestions: string[];
  readonly retryable: boolean;
  readonly context: SvhErrorContext;
  /** 内部技术细节，仅用于日志 */
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: SvhErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.userMessage = options.userMessage ?? USER_MESSAGE_BY_CODE[code];
    this.suggestions = options.suggestions ?? SUGGESTIONS_BY_CODE[code] ?? [];
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.context = options.context ?? {};
    this.details = options.cause;
  }

  /** 序列化为面向用户的错误响应（不含技术细节） */
  toUserResponse(): UserFacingError {
    return {
      code: this.code,
      message: this.userMessage,
      suggestions: this.suggestions,
      retryable: this.retryable,
    };
  }

  /** 序列化为日志用结构（含技术细节） */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: serializeCause(this.details) } : {}),
    };
  }
}

/** 默认是否可重试：模型与任务类错误通常可重试 */
function defaultRetryable(code: ErrorCode): boolean {
  return (
    code === 'PROVIDER_UNAVAILABLE' ||
    code === 'MODEL_RATE_LIMITED' ||
    code === 'MODEL_TIMEOUT' ||
    code === 'MODEL_BAD_OUTPUT' ||
    code === 'TASK_TIMEOUT' ||
    code === 'RATE_LIMITED' ||
    code === 'INTERNAL_ERROR'
  );
}

/** 序列化任意 cause，避免循环引用导致日志失败 */
function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack };
  }
  try {
    JSON.stringify(cause);
    return cause;
  } catch {
    return String(cause);
  }
}

/** 面向用户的错误响应（API 返回体） */
export interface UserFacingError {
  code: ErrorCode;
  message: string;
  suggestions: string[];
  retryable: boolean;
}

/** 校验失败 */
export class ValidationError extends SvhError {
  constructor(message: string, options: SvhErrorOptions & { issues?: unknown } = {}) {
    super('VALIDATION_FAILED', message, {
      ...options,
      userMessage: options.userMessage ?? '提交的内容有问题，请检查后重试。',
      suggestions: options.suggestions ?? ['检查必填项是否完整', '检查格式是否正确'],
    });
  }
}

/** 请求非法 */
export class BadRequestError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('BAD_REQUEST', message, options);
  }
}

/** 未认证 */
export class UnauthorizedError extends SvhError {
  constructor(message = '未认证', options: SvhErrorOptions = {}) {
    super('UNAUTHORIZED', message, options);
  }
}

/** 无权限 */
export class ForbiddenError extends SvhError {
  constructor(message = '无权限', options: SvhErrorOptions = {}) {
    super('FORBIDDEN', message, options);
  }
}

/**
 * 资源不存在。
 *
 * 支持通过 `resourceLabel` 生成更有用的用户文案：
 * 「项目不存在」远比笼统的「没有找到对应的内容」更有助于用户定位问题。
 * 技术文档第 66 条要求错误必须说明「发生了什么」，这一层就是它的落点。
 */
export class NotFoundError extends SvhError {
  constructor(
    message: string,
    options: SvhErrorOptions & { resourceLabel?: string } = {},
  ) {
    const { resourceLabel, ...rest } = options;
    super('NOT_FOUND', message, {
      ...rest,
      userMessage:
        rest.userMessage ??
        (resourceLabel !== undefined
          ? `${resourceLabel}不存在，可能已被删除。`
          : '没有找到对应的内容。'),
      suggestions:
        rest.suggestions ?? ['确认该内容是否已被删除', '返回列表重新选择'],
    });
  }
}

/** 状态冲突 */
export class ConflictError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('CONFLICT', message, options);
  }
}

/** 模型未配置 */
export class ModelNotConfiguredError extends SvhError {
  constructor(message = '没有可用的模型配置', options: SvhErrorOptions = {}) {
    super('MODEL_NOT_CONFIGURED', message, options);
  }
}

/** 模型服务不可用 */
export class ProviderUnavailableError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('PROVIDER_UNAVAILABLE', message, options);
  }
}

/** 模型调用超时 */
export class ModelTimeoutError extends SvhError {
  constructor(message = '模型调用超时', options: SvhErrorOptions = {}) {
    super('MODEL_TIMEOUT', message, options);
  }
}

/** 模型返回内容无法解析 */
export class ModelBadOutputError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('MODEL_BAD_OUTPUT', message, options);
  }
}

/**
 * 内容被模型的安全策略拒绝。
 *
 * **不可重试**：同样的提示词重试多少次都会被拒。用户必须调整描述，
 * 因此不能笼统地报成「模型服务不可用」——那会让用户以为等一会就好。
 */
export class ModelContentRejectedError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('MODEL_CONTENT_REJECTED', message, {
      ...options,
      retryable: false,
      userMessage: options.userMessage ?? '内容未通过模型的安全校验，请调整描述后重试。',
      suggestions: options.suggestions ?? ['调整描述用词后重试', '避免涉及敏感内容'],
    });
  }
}

/** 模型限流 */
export class ModelRateLimitedError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('MODEL_RATE_LIMITED', message, {
      ...options,
      retryable: true,
    });
  }
}

/** 任务相关错误 */
export class TaskError extends SvhError {
  constructor(
    code: Extract<ErrorCode, 'TASK_NOT_FOUND' | 'TASK_NOT_CANCELLABLE' | 'TASK_TIMEOUT'>,
    message: string,
    options: SvhErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** 资产相关错误：用户文案点明是「资产」，而不是笼统的「内容」 */
export class AssetError extends SvhError {
  constructor(
    code: Extract<ErrorCode, 'ASSET_NOT_FOUND' | 'ASSET_IN_USE' | 'ASSET_VERSION_NOT_FOUND'>,
    message: string,
    options: SvhErrorOptions = {},
  ) {
    super(code, message, {
      ...options,
      userMessage:
        options.userMessage ??
        (code === 'ASSET_VERSION_NOT_FOUND'
          ? '没有找到该资产的历史版本。'
          : USER_MESSAGE_BY_CODE[code]),
      suggestions:
        options.suggestions ??
        (code === 'ASSET_NOT_FOUND'
          ? ['确认该资产是否已被删除', '在资产库中重新搜索']
          : SUGGESTIONS_BY_CODE[code] ?? []),
    });
  }
}

/** 内容相关错误：用户文案点明是「内容」 */
export class ContentError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('CONTENT_NOT_FOUND', message, {
      ...options,
      userMessage: options.userMessage ?? '没有找到对应的内容，可能已被删除。',
      suggestions: options.suggestions ?? ['返回内容列表重新选择'],
    });
  }
}

/** Workflow 定义非法 */
export class WorkflowInvalidError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('WORKFLOW_INVALID', message, options);
  }
}

/** Skill 未找到：用户文案点明是「技能」，与其它 404 资源语义保持一致 */
export class SkillNotFoundError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('SKILL_NOT_FOUND', message, {
      ...options,
      userMessage: options.userMessage ?? '没有找到对应的技能，它可能尚未开放。',
      suggestions: options.suggestions ?? ['在 /技能 菜单中选择一个可用技能'],
    });
  }
}

/** 会员等级不足 */
export class TierRequiredError extends SvhError {
  constructor(
    message: string,
    options: SvhErrorOptions & { requiredTier?: string; currentTier?: string } = {},
  ) {
    super('SKILL_TIER_REQUIRED', message, options);
  }
}

/** 高风险操作需要用户确认 */
export class ConfirmationRequiredError extends SvhError {
  constructor(message: string, options: SvhErrorOptions = {}) {
    super('CONFIRMATION_REQUIRED', message, options);
  }
}

/** 判断是否为 SvhError */
export function isSvhError(err: unknown): err is SvhError {
  return err instanceof SvhError;
}

/**
 * 把任意异常归一化为 SvhError。
 * 未知异常一律包装为 INTERNAL_ERROR，原始信息只进日志。
 */
export function toSvhError(err: unknown): SvhError {
  if (isSvhError(err)) return err;
  if (err instanceof z.ZodError) {
    return new ValidationError('参数校验失败', {
      cause: err,
      userMessage: '提交的内容有问题，请检查后重试。',
    });
  }
  if (err instanceof Error) {
    return new SvhError('INTERNAL_ERROR', err.message, { cause: err });
  }
  return new SvhError('INTERNAL_ERROR', String(err), { cause: err });
}

/** API 错误响应体（客户端可见） */
export interface ApiErrorResponse {
  ok: false;
  error: UserFacingError;
  /** 请求追踪 id，用户报障时可提供 */
  requestId?: string;
}

/** API 成功响应体 */
export interface ApiSuccessResponse<T> {
  ok: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** 错误响应校验器（前后端共用） */
export const userFacingErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  suggestions: z.array(z.string()).default([]),
  retryable: z.boolean().default(false),
});
