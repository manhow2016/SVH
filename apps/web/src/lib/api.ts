/**
 * API 客户端。
 *
 * ── 与后端传输契约的对应 ──
 * 后端刻意**不用** `{code, data, message}` 包打天下：
 * 成功直接返回资源本身，失败返回
 * `{ error: { code, message, suggestions, retryable }, requestId? }`。
 * 因此这里没有统一的响应包装类型 —— 调用方拿到的就是资源。
 *
 * ── 本文件存在的理由 ──
 * 把后端的错误体翻译成一个**界面可以直接用**的异常类型。
 * 如果在这里把 suggestions 丢掉，界面就再也补不回来了 ——
 * 而规范要求错误必须说明「发生了什么 / 可能原因 / 下一步怎么做」。
 */

/** 面向界面的 API 错误。字段与后端错误体一一对应。 */
export class ApiError extends Error {
  readonly code: string;
  readonly suggestions: string[];
  readonly retryable: boolean;
  readonly status: number;
  readonly requestId?: string;

  constructor(input: {
    message: string;
    code: string;
    suggestions: string[];
    retryable: boolean;
    status: number;
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.suggestions = input.suggestions;
    this.retryable = input.retryable;
    this.status = input.status;
    if (input.requestId !== undefined) this.requestId = input.requestId;
  }
}

/** 后端错误体形状（防御式读取，结构不符时回退） */
interface RawErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    suggestions?: unknown;
    retryable?: unknown;
  };
  requestId?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 从原始响应体里尽力提取错误信息；任何异常都退化为通用文案 */
function toApiError(status: number, raw: unknown): ApiError {
  const body = (raw ?? {}) as RawErrorBody;
  const error = body.error;

  const message =
    typeof error?.message === 'string' && error.message.length > 0
      ? error.message
      : status >= 500
        ? '服务暂时不可用，请稍后重试。'
        : '请求未能完成。';

  return new ApiError({
    message,
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    suggestions: isStringArray(error?.suggestions) ? error.suggestions : [],
    // 5xx 与网络问题默认可重试；4xx 交给后端显式声明
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : status >= 500,
    status,
    ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
  });
}

/**
 * 发起请求。
 *
 * 成功时返回资源本身；失败时**总是**抛出 `ApiError`
 * （包括网络不可达与非 JSON 响应 —— 调用方只需处理一种异常类型）。
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  /*
   * 用 Headers 归一化，而不是直接展开 `init.headers`：
   * `Headers` 实例的条目不是自有可枚举属性，展开会得到空对象 ——
   * 调用方传 Headers 时所有的头会被**静默丢掉**。
   */
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    // 网络层失败（后端没起、断网）。刻意不把 "Failed to fetch" 透给用户。
    throw new ApiError({
      message: '无法连接到服务，请确认后端已启动。',
      code: 'NETWORK_ERROR',
      suggestions: ['确认后端服务正在运行', '检查网络连接后重试'],
      retryable: true,
      status: 0,
    });
  }

  // 204 与其它空 body 的成功响应
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  const text = await response.text();
  if (text.length === 0) {
    // 200 也可能没有 body（例如某些代理下的 DELETE）：同 204 处理
    return undefined as T;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // 非 JSON（例如反向代理返回的 HTML 错误页）
    if (!response.ok) {
      throw new ApiError({
        message: '服务返回了无法识别的内容，请稍后重试。',
        code: 'INVALID_RESPONSE',
        suggestions: ['稍后重试', '若持续出现请联系管理员'],
        retryable: response.status >= 500,
        status: response.status,
      });
    }
    throw new ApiError({
      message: '服务返回了无法识别的内容。',
      code: 'INVALID_RESPONSE',
      suggestions: [],
      retryable: false,
      status: response.status,
    });
  }

  if (!response.ok) {
    throw toApiError(response.status, parsed);
  }

  return parsed as T;
}

/** 便捷方法：JSON body 的 POST */
export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

/** 便捷方法：PATCH */
export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
