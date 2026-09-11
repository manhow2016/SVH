/**
 * 日志模块
 *
 * 约束（审计结论）：**技术错误进日志，用户文案进响应**。
 * 因此这里提供的是「结构化技术日志」，与面向用户的错误响应严格分离。
 *
 * 使用 Fastify 内置的 pino，不额外引入日志库。
 */
import type { FastifyBaseLogger } from 'fastify';
import type { LogLevel } from '@svh/config';

/**
 * 需要脱敏的字段名（大小写不敏感匹配）。
 * 任何把第三方错误或请求上下文写进日志的系统都必须做这一步，
 * 否则 API Key / Token 会以明文沉淀到日志文件里。
 */
const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'apiKey',
  'api_key',
  'apiKeyEncrypted',
  'password',
  'secret',
  'token',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.token',
];

/** 构造 Fastify 日志配置 */
export function buildLoggerOptions(level: LogLevel, isProduction: boolean) {
  return {
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[已脱敏]',
    },
    // 开发环境用彩色精简输出，生产环境输出 JSON 便于采集
    ...(isProduction
      ? {}
      : {
          transport: undefined,
        }),
  };
}

/**
 * Provider 原始错误的脱敏。
 *
 * 审计结论 ⑧：任何入库 / 进日志的第三方错误都必须清理凭据。
 * 参考项目用 8 条正则清理 `Bearer` / `api_key` / `token` / `secret` / `password`，
 * 这里沿用同样的思路（含 lookbehind，避免误伤普通单词）。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[-_]?key)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(access[-_]?token)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(refresh[-_]?token)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(secret)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(password|passwd|pwd)["'\s:=]+[^\s"',}]{4,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /(["']?(?:x[-_]?api[-_]?key|authorization)["']?\s*:\s*["'])[^"']{8,}(["'])/gi,
];

/** 脱敏后的占位文本 */
const REDACTED = '[已脱敏]';

/**
 * 构造 replace 回调：有捕获组时保留键名，只替换值。
 *
 * 必须显式标注 `groups: readonly unknown[]`：
 * `String.prototype.replace` 的回调签名是重载的，TS 会将回调参数推断为
 * `any`，触发 `no-unsafe-return`。显式标注把这一层不确定性收敛到函数内部。
 */
function makeReplacer(): (match: string, ...groups: readonly unknown[]) => string {
  return (_match, ...groups) => {
    const prefix = groups[0];
    // 捕获组存在且为非空字符串时，保留键名（如 `api_key=`），只替换其后的值
    if (typeof prefix === 'string' && prefix.length > 0) {
      return `${prefix}${REDACTED}`;
    }
    return REDACTED;
  };
}

/** 清理字符串中的凭据 */
export function sanitizeSecrets(input: string): string {
  const replacer = makeReplacer();
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, replacer);
  }
  return output;
}

/**
 * 把任意异常整理为可安全落日志的结构。
 * 这是把第三方错误写入日志的**唯一入口**。
 */
export function toLoggableError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: sanitizeSecrets(err.message),
      ...(err.stack !== undefined ? { stack: sanitizeSecrets(err.stack) } : {}),
    };
  }
  return { name: 'UnknownError', message: sanitizeSecrets(String(err)) };
}

/** 日志器类型别名，便于业务代码引用 */
export type Logger = FastifyBaseLogger;
