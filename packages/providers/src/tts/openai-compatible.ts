/**
 * OpenAI Compatible TTS 适配器（/v1/audio/speech）。
 *
 * 契约（多数兼容网关同形）：
 *   POST {base}/audio/speech
 *   body: { model, input, voice?, response_format? }
 *   resp: 音频二进制（audio/mpeg 等）→ 转 base64 落 metadata.b64Json；
 *         或 JSON { url }（部分网关）→ 直连远程 URL。
 */
import {
  buildAuthHeaders,
  isAbortError,
  normalizeBaseUrl,
  truncate,
} from "../http";
import type { TTSService, TTSSynthesisInput, TTSSynthesisResult } from "./provider";

const SPEECH_PATH = "/audio/speech";

export interface OpenAICompatibleTTSOptions {
  apiKey?: string;
  baseUrl?: string;
}

/** 二进制响应 → base64（Node Buffer；浏览器环境兜底 btoa） */
function toBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export class OpenAICompatibleTTSService implements TTSService {
  readonly id = "openai-compatible-tts";
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OpenAICompatibleTTSOptions) {
    this.baseUrl = options.baseUrl ? normalizeBaseUrl(options.baseUrl) : "";
    this.apiKey = options.apiKey?.trim() || undefined;
  }

  async synthesize(
    input: TTSSynthesisInput,
    signal?: AbortSignal,
  ): Promise<TTSSynthesisResult> {
    if (!this.baseUrl) {
      throw new Error("TTS baseUrl 未配置（语音合成需要支持 /v1/audio/speech 的网关）");
    }
    const body: Record<string, unknown> = {
      model: input.model,
      input: input.input,
      response_format: input.responseFormat ?? "mp3",
    };
    if (input.voice) body.voice = input.voice;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${SPEECH_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(this.apiKey),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error("TTS request aborted", { cause: err });
      }
      throw new Error(`TTS request failed: ${(err as Error).message}`, { cause: err });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `TTS request failed (${response.status}${detail ? `: ${truncate(detail, 500)}` : ""})`,
      );
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    // JSON 形态：{ url }（部分网关）
    if (contentType?.includes("json")) {
      const json = (await response.json()) as { url?: string; audio?: string };
      const url = json.url ?? (typeof json.audio === "string" && /^https?:\/\//.test(json.audio) ? json.audio : undefined);
      if (!url) {
        throw new Error("TTS response JSON 中无 url");
      }
      return { url, contentType };
    }
    // 二进制形态：转 base64 落库（与图片 b64Json 同款约定）
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new Error("TTS response is empty");
    }
    return {
      b64Json: toBase64(buffer),
      contentType: contentType ?? "audio/mpeg",
    };
  }
}
