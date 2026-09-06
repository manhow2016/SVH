/**
 * Provider 公共 HTTP 工具（V0.2：chat / image / video 复用）。
 */

/** 规范化 baseUrl：trim + 去除末尾斜杠；空值抛错 */
export function normalizeBaseUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") {
    throw new Error("baseUrl is required");
  }
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base === "") {
    throw new Error("baseUrl is required");
  }
  return base;
}

/** 构造鉴权头（apiKey 为空时不带 Authorization，兼容本地模型） */
export function buildAuthHeaders(apiKey?: string): { Authorization?: string } {
  const key = apiKey?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** 错误详情截断（控制输出长度） */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 是否为中止错误（AbortError / TimeoutError） */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}
