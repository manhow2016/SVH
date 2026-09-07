/**
 * 资产本地化下载器（设计文档 §4）：worker 转存主路径与 server 手动重试共用。
 *
 * 语义钉死：
 * - 4 次尝试 = 首次 + 3 次指数退避重试；失败之间依次等待 500 / 2000 / 8000ms，
 *   末次失败直接返回，不再消耗等待
 * - 边下边写 `destPath.part`，整成功后同目录 rename 原子到位；任何失败路径不留 part 或半文件
 * - 确定性超限（Content-Length 预检、流式累计计数）不重试，立即失败返回
 * - 全部尝试失败只返回 `{ok:false,error}`，绝不抛异常（调用方据此「宽落库」）
 * - 错误文本只留主机名+路径并洗掉 query，防供应商签名参数写进日志与数据库
 */
import { mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** 默认单文件上限 500MB（设计文档 §11：拍脑袋常数，env 可调） */
export const DEFAULT_LOCALIZE_MAX_BYTES = 500 * 1024 * 1024;
/** 默认单次尝试超时 60s */
export const DEFAULT_LOCALIZE_TIMEOUT_MS = 60_000;
/** error 文本长度上限（防供应商超长响应体灌进数据库 metadata 列） */
const MAX_ERROR_LENGTH = 400;

/** 3 次重试的退避时长：尝试次数 = BACKOFF_MS.length + 1（首次不等待） */
const BACKOFF_MS: readonly number[] = [500, 2000, 8000];
const ATTEMPTS = BACKOFF_MS.length + 1;

export interface LocalizeOptions {
  /** 供应商远程地址（可能带签名 query） */
  url: string;
  /** 最终落盘绝对路径；父目录不存在时自动创建 */
  destPath: string;
  /** 字节上限，默认 DEFAULT_LOCALIZE_MAX_BYTES */
  maxBytes?: number;
  /** 单次尝试超时，默认 DEFAULT_LOCALIZE_TIMEOUT_MS */
  timeoutMs?: number;
  /** 注入点：测试用假网络 */
  fetchImpl?: typeof fetch;
  /** 注入点：测试用假退避（记录等待序列） */
  sleep?: (ms: number) => Promise<void>;
}

export type LocalizeResult = { ok: true; bytes: number; contentType?: string } | { ok: false; error: string };

/** 单次尝试结果：retryable=false 表示确定性失败（超限），不再重试 */
type AttemptOutcome =
  | { ok: true; bytes: number; contentType?: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * metadata.localization 约定结构（设计文档 §3，零迁移：嵌在 assets.metadata JSON 内）。
 * 无该键 = 从未尝试本地化（远程模式）。
 */
export interface LocalizeMetadata {
  state: "ready" | "failed";
  error?: string;
  bytes?: number;
  /** ISO 时间戳 */
  at?: string;
}

/** metadata 内约定键名（Task 2/4 共用，避免字符串漂移） */
export const LOCALIZE_METADATA_KEY = "localization" as const;

/**
 * 本地化产物目录前缀（DB workspacePath 相对段唯一权威，终审 M①）：
 * worker 写入路径、server 手动重试路径与 DELETE 清理判据三处共用同一常量——
 * 任何一侧改字面量都会让 `startsWith` 判据静默失效，字符串常量为漂移上锁。
 */
export const LOCALIZE_DIR_PREFIX = "media/" as const;

/** 转存一个远程文件到本地路径（原子：先写 part 再 rename）。永不抛异常。 */
export async function localizeToFile(options: LocalizeOptions): Promise<LocalizeResult> {
  const { url, destPath } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_LOCALIZE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCALIZE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const partPath = `${destPath}.part`;

  try {
    await mkdir(dirname(destPath), { recursive: true });
  } catch (error) {
    return { ok: false, error: sanitize(url, `无法创建目标目录：${reasonOf(error)}`) };
  }

  let lastError = "未知错误";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const outcome = await attemptOnce({ url, destPath, partPath, maxBytes, timeoutMs, fetchImpl });
    if (outcome.ok) {
      return outcome.contentType === undefined
        ? { ok: true, bytes: outcome.bytes }
        : { ok: true, bytes: outcome.bytes, contentType: outcome.contentType };
    }
    lastError = outcome.error;
    if (!outcome.retryable) {
      // 确定性失败（超限）：重试不会改变结果，立即返回，不消耗等待
      return { ok: false, error: sanitize(url, `确定性失败，重试无意义：${lastError}`) };
    }
    if (attempt < ATTEMPTS - 1) {
      await sleep(BACKOFF_MS[attempt] ?? 0);
    }
  }
  return { ok: false, error: sanitize(url, `${ATTEMPTS} 次尝试均失败：${lastError}`) };
}

/** 单次下载尝试：抛错与非 2xx 均可重试，超限不可重试 */
async function attemptOnce(o: {
  url: string;
  destPath: string;
  partPath: string;
  maxBytes: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await o.fetchImpl(o.url, { signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (error) {
    return { ok: false, error: `请求失败：${reasonOf(error)}`, retryable: true };
  }

  if (!response.ok) {
    await cancelQuietly(response);
    return { ok: false, error: `HTTP ${response.status}`, retryable: true };
  }
  if (!response.body) {
    return { ok: false, error: "响应无 body", retryable: true };
  }

  // Content-Length 预检：解析失败（NaN）不算超限，交给流式计数兜底
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > o.maxBytes) {
    await cancelQuietly(response);
    return { ok: false, error: `响应声明 ${declared} 字节，超过上限 ${o.maxBytes} 字节`, retryable: false };
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const stream = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
  // 占位 error 监听：fromWeb 到下方 for-await 挂监听之间隔着 `await open` 的宏任务窗口，
  // 断流的 'error' 若在此窗口 emit 且无人监听，Node 会升级为 uncaughtException 直接打死进程。
  // 这里只占位防 emit，错误语义仍由消费侧（for-await rejection → catch 分支）收敛。
  stream.on("error", () => undefined);
  let handle: FileHandle | null = null;
  let bytes = 0;
  try {
    handle = await open(o.partPath, "w");
    for await (const raw of stream) {
      const chunk = raw as Uint8Array;
      bytes += chunk.byteLength;
      if (bytes > o.maxBytes) {
        return { ok: false, error: `下载累计 ${bytes} 字节，超过上限 ${o.maxBytes} 字节`, retryable: false };
      }
      await handle.write(chunk);
    }
    await handle.close();
    handle = null;
    try {
      await rename(o.partPath, o.destPath);
    } catch (error) {
      // rename 失败（跨设备/权限）也要清掉 part，目录不得留半文件
      await unlink(o.partPath).catch(() => undefined);
      return { ok: false, error: `改名落盘失败：${reasonOf(error)}`, retryable: true };
    }
    return { ok: true, bytes, contentType };
  } catch (error) {
    return { ok: false, error: `写入失败：${reasonOf(error)}`, retryable: true };
  } finally {
    if (!stream.destroyed) {
      stream.destroy();
    }
    if (handle) {
      await handle.close().catch(() => undefined);
      await unlink(o.partPath).catch(() => undefined);
    }
  }
}

/** Content-Type → 落盘扩展名（未知类型返回 null，由调用方按资产 kind 兜底） */
export function extFromContentType(contentType: string | undefined): "mp4" | "png" | "webp" | "jpg" | null {
  if (!contentType) {
    return null;
  }
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "video/mp4":
      return "mp4";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
      return "jpg";
    default:
      return null;
  }
}

/** 从 env 读取转存上限与超时（非法值回退默认） */
export function readLocalizeConfig(env: NodeJS.ProcessEnv): { maxBytes: number; timeoutMs: number } {
  return {
    maxBytes: parsePositiveInt(env.SVH_LOCALIZE_MAX_BYTES, DEFAULT_LOCALIZE_MAX_BYTES),
    timeoutMs: parsePositiveInt(env.SVH_LOCALIZE_TIMEOUT_MS, DEFAULT_LOCALIZE_TIMEOUT_MS),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cancelQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 释放连接失败不影响失败结论
  }
}

/** 主机名+路径（丢弃 query：供应商签名参数不得进入日志与数据库） */
function hostPathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/** 把错误文本里出现的完整 URL / 签名参数换成无敏形式，并限长 */
function sanitize(url: string, text: string): string {
  let out = text.split(url).join(hostPathOf(url));
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams) {
      out = out.split(`${key}=${value}`).join(`${key}=***`);
      if (value.length >= 8) {
        out = out.split(value).join("***");
      }
    }
  } catch {
    // 非标准 URL：已按 ? 截断处理
  }
  return out.length > MAX_ERROR_LENGTH ? `${out.slice(0, MAX_ERROR_LENGTH)}…` : out;
}
