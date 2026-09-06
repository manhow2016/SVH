/**
 * OpenAI Compatible Image Provider（文档 §13.2）。
 *
 * 端点：POST {baseUrl}/images/generations
 * 兼容：OpenAI 兼容系供应商（火山方舟 / 阿里云百炼 compatible-mode 等）。
 */
import { buildAuthHeaders, normalizeBaseUrl, truncate, isAbortError } from "../http";
import type {
  ImageGenerationInput,
  ImageGenerationResult,
  ImageProvider,
} from "./provider";

export interface OpenAICompatibleImageOptions {
  baseUrl: string;
  apiKey?: string;
}

interface OpenAICompatibleImageResponse {
  created?: number;
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

export class OpenAICompatibleImageProvider implements ImageProvider {
  readonly id = "openai-compatible-image";
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OpenAICompatibleImageOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || undefined;
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      n: input.n ?? 1,
    };
    if (input.size) body.size = input.size;
    if (input.responseFormat) body.response_format = input.responseFormat;
    if (input.seed !== undefined) body.seed = input.seed;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/images/generations`, {
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
        throw new Error("Image request aborted", { cause: err });
      }
      throw new Error(`Image request failed: ${(err as Error).message}`, { cause: err });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Image request failed (${response.status}${detail ? `: ${truncate(detail, 500)}` : ""})`,
      );
    }

    let json: OpenAICompatibleImageResponse;
    try {
      json = (await response.json()) as OpenAICompatibleImageResponse;
    } catch {
      throw new Error("Image response is not valid JSON");
    }

    const images = (json.data ?? []).map((img) => ({
      url: img.url,
      b64Json: img.b64_json,
      revisedPrompt: img.revised_prompt,
    }));
    if (images.length === 0) {
      throw new Error("Image response contains no images");
    }
    return { images, created: json.created, raw: json };
  }
}
