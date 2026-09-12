/**
 * Provider 适配器的共享工具
 *
 * 三个适配器（OpenAI 兼容 / Anthropic / Gemini）在协议细节上不同，
 * 但在**网络层与错误处理**上完全一致。把这些收敛到一处，避免三份重复实现：
 *
 * - 超时与取消信号传导（AbortSignal）
 * - HTTP 错误 → 领域错误的映射（这是用户看到「模型服务暂时不可用」而非
 *   `AxiosError: Request failed with status code 429` 的关键）
 * - 凭据脱敏（绝不能把 API Key 写进错误信息或日志）
 * - JSON 解析容错（有些 Provider 在错误时返回 HTML）
 */
import {
  ModelBadOutputError,
  ModelContentRejectedError,
  ModelTimeoutError,
  ProviderUnavailableError,
  ValidationError,
} from '@svh/domain';

/** 一次 HTTP 调用的结果 */
export interface HttpJsonResult {
  status: number;
  /** 解析后的 JSON；解析失败时为 null */
  body: unknown;
  /** 原始文本（截断后），用于错误信息与排查 */
  rawText: string;
  headers: Headers;
}

/** 请求选项 */
export interface HttpRequestOptions {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** JSON 请求体；GET 时省略 */
  json?: unknown;
  /** 超时（毫秒） */
  timeoutMs: number;
  /** 外部取消信号（来自任务的 AbortSignal） */
  signal?: AbortSignal;
  /**
   * Provider 名称，仅用于错误信息。
   * 注意：**不要**把 baseUrl 或 API Key 放进这里。
   */
  providerLabel: string;
}

/**
 * 发送 HTTP 请求并解析 JSON。
 *
 * 本函数**不抛领域错误**，而是把 HTTP 层的失败统一交给
 * `mapHttpErrorToSvhError` 处理 —— 保持「传输」与「语义」两层分离，
 * 便于单独测试错误映射。
 */
export async function requestJson(options: HttpRequestOptions): Promise<HttpJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  // 把外部取消信号桥接到本地控制器：
  // 用户在 Agent UI 点「取消」时必须真的停止请求，否则 Provider 侧会继续计费。
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(options.url, {
      method: options.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
      ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let body: unknown = null;
    if (rawText.length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch {
        // 部分网关在 5xx 时返回 HTML 错误页，此时 body 保持 null，
        // 由错误映射给出可读提示
        body = null;
      }
    }

    return {
      status: response.status,
      body,
      // 截断避免把整页 HTML 塞进错误信息
      rawText: rawText.slice(0, 2000),
      headers: response.headers,
    };
  } catch (err) {
    // 网络层异常（DNS、连接拒绝、TLS 失败、abort）
    if (controller.signal.aborted) {
      // 区分「我们的超时」与「外部取消」
      if (options.signal?.aborted === true) {
        throw new ProviderUnavailableError(`${options.providerLabel} 的请求已被取消`, {
          cause: err,
          retryable: false,
          userMessage: '请求已取消。',
          context: { providerLabel: options.providerLabel },
        });
      }
      throw new ModelTimeoutError(`${options.providerLabel} 请求超时（${options.timeoutMs}ms）`, {
        cause: err,
        context: { providerLabel: options.providerLabel, timeoutMs: options.timeoutMs },
      });
    }
    throw new ProviderUnavailableError(
      `${options.providerLabel} 网络请求失败：${err instanceof Error ? err.message : String(err)}`,
      { cause: err, context: { providerLabel: options.providerLabel } },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 从 Provider 的 JSON 错误体中提取人类可读的说明。
 *
 * 各家的错误结构不同（OpenAI 用 `error.message`、Anthropic 用 `error.message`、
 * Gemini 用 `error.message` 或 `error.status`），这里做兼容提取并**脱敏**。
 */
export function extractErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;

  const error = record.error;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }

  // Gemini 的部分错误直接在顶层
  for (const key of ['message', 'detail', 'status']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * 凭据脱敏。
 *
 * 审计结论 ⑧：任何入库或进日志的第三方错误都必须清理凭据。
 * 这里在**适配器层**就做一次，保证错误信息在任何出口都是安全的。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[-_]?key)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
];

/**
 * 清理文本中的凭据。
 *
 * replacer 显式标注参数类型：`String.prototype.replace` 的回调签名是重载的，
 * TS 会把参数推断为 `any`，触发 no-unsafe-return。
 */
function credentialReplacer(_match: string, ...groups: readonly unknown[]): string {
  const key = groups[0];
  return typeof key === 'string' && key.length > 0 ? `${key}[已脱敏]` : '[已脱敏]';
}

/** 清理文本中的凭据 */
export function sanitizeCredentials(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, credentialReplacer);
  }
  return output;
}

/**
 * HTTP 状态码 → 领域错误。
 *
 * 映射规则（决定了用户看到什么、以及是否值得重试）：
 * - 401 / 403 → 凭据或权限问题。**不可重试**（重试只会继续失败），
 *   且必须提示用户去检查配置，而不是笼统地说「服务不可用」
 * - 404 → 模型不存在，通常是模型名配错。不可重试
 * - 429 → 限流。**可重试**，且适合切换到备用模型
 * - 400 / 422 → 请求不合法（提示词过长、参数越界）。
 *   注意：内容安全拦截也常走 400，此时需要区分对待
 * - 5xx / 529 → 服务端故障。可重试 + 可降级
 */
export function mapHttpErrorToSvhError(input: {
  status: number;
  body: unknown;
  rawText: string;
  providerLabel: string;
}): never {
  const { status, body, rawText, providerLabel } = input;
  const detailRaw = extractErrorMessage(body) ?? rawText.slice(0, 500);
  const detail = sanitizeCredentials(detailRaw);

  // 内容安全拦截：各家的措辞不同，这里做关键词识别
  const isContentBlocked =
    status === 400 &&
    /content|safety|policy|blocked|filter|敏感|违规/i.test(detail);

  if (isContentBlocked) {
    // 内容安全拦截走专门的错误码：它**不可通过重试解决**，
    // 用户需要调整描述，因此不能笼统地报「服务不可用」。
    throw new ModelContentRejectedError(`${providerLabel} 拒绝了该内容：${detail}`, {
      context: { status },
    });
  }

  switch (status) {
    case 400:
    case 422:
      throw new ValidationError(`${providerLabel} 拒绝了请求（${status}）：${detail}`, {
        suggestions: ['检查提示词是否过长或包含不支持的参数', '调整描述后重试'],
        context: { status },
      });

    case 401:
    case 403:
      throw new ProviderUnavailableError(`${providerLabel} 鉴权失败（${status}）：${detail}`, {
        retryable: false,
        userMessage: '模型服务的 API Key 无效或权限不足。',
        suggestions: ['在设置中检查 API Key 是否正确', '确认该 Key 有权限调用此模型'],
        context: { status },
      });

    case 404:
      throw new ProviderUnavailableError(`${providerLabel} 找不到指定模型（404）：${detail}`, {
        retryable: false,
        userMessage: '配置的模型名称不存在。',
        suggestions: ['在设置中检查模型名称是否与 Provider 提供的一致'],
        context: { status },
      });

    case 429:
      throw new ProviderUnavailableError(`${providerLabel} 触发限流（429）：${detail}`, {
        retryable: true,
        userMessage: '模型调用过于频繁，请稍后再试。',
        suggestions: ['稍等片刻后重试', '降低并发或更换 Provider'],
        context: { status },
      });

    default:
      if (status >= 500) {
        throw new ProviderUnavailableError(`${providerLabel} 服务端错误（${status}）：${detail}`, {
          retryable: true,
          context: { status },
        });
      }
      throw new ProviderUnavailableError(`${providerLabel} 返回异常状态（${status}）：${detail}`, {
        context: { status },
      });
  }
}

/**
 * 校验并返回一次成功响应的 JSON 对象。
 *
 * 成功状态码（2xx）但响应体不是对象时，属于 Provider 行为异常，
 * 报 `MODEL_BAD_OUTPUT`（可重试）而不是崩溃。
 */
export function ensureJsonObject(result: HttpJsonResult, providerLabel: string): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    mapHttpErrorToSvhError({
      status: result.status,
      body: result.body,
      rawText: result.rawText,
      providerLabel,
    });
  }
  if (result.body === null || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw new ModelBadOutputError(`${providerLabel} 返回的响应不是 JSON 对象`, {
      context: { providerLabel, status: result.status },
    });
  }
  return result.body as Record<string, unknown>;
}

/** 安全地按路径取值（避免 `a.b.c` 中途为 undefined 时抛错） */
export function getPath(source: unknown, ...path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 拼接 baseUrl 与路径，避免出现双斜杠或缺斜杠 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * 把领域层的能力映射为 Provider 的模型端点路径。
 *
 * 各家的媒体生成端点差异很大，因此由适配器自己决定路径，
 * 这里只提供通用的「能力 → 路径模板」查询能力。
 */
export function pickPath(
  capability: string,
  routes: Record<string, string>,
  fallback: string,
): string {
  return routes[capability] ?? fallback;
}
