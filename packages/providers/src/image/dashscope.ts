/**
 * DashScope（阿里云百炼）文生图适配器。
 *
 * 百炼图片模型（qwen-image / 通义万相）**不提供** OpenAI 兼容的
 * `/images/generations` 端点（实测 404），使用 DashScope 原生同步接口：
 *
 *   POST {serviceBase}/services/aigc/multimodal-generation/generation
 *   body: { model, input: { messages: [{ role, content: [{ text }] }] }, parameters }
 *   resp: { output: { choices: [{ message: { content: [{ image: "url" }] } }] } }
 *         或（万相旧版异步任务查询同构）{ output: { results: [{ url }] } }
 *
 * 输出统一映射到 ImageGenerationResult（url 形态）。
 */
import type {
  ImageGenerationInput,
  ImageGenerationResult,
  ImageProvider,
} from "./provider";
import { DASHSCOPE_SERVICE_BASE } from "../video/dashscope";
import { buildAuthHeaders, isAbortError, truncate } from "../http";

const MULTIMODAL_GENERATION_PATH = "/services/aigc/multimodal-generation/generation";

export interface DashScopeImageOptions {
  apiKey: string;
  /** 覆盖原生服务基址（测试用），默认 https://dashscope.aliyuncs.com/api/v1 */
  serviceBase?: string;
}

interface DashScopeContentPart {
  image?: string;
  text?: string;
}

interface DashScopeImageResponse {
  output?: {
    choices?: Array<{ message?: { content?: DashScopeContentPart[] } }>;
    results?: Array<{ url?: string }>;
  };
  request_id?: string;
  code?: string;
  message?: string;
}

/** OpenAI 风格 size（"1024x1024"）→ DashScope 风格（"1024*1024"） */
function toNativeSize(size: string | undefined): string | undefined {
  return size?.replace(/x/gi, "*");
}

export class DashScopeImageProvider implements ImageProvider {
  readonly id = "dashscope-image";
  /** qwen-image / 通义万相多模态支持 image 内容块（参考图 → 图生图/角色参照），Phase B */
  readonly referenceImageSupport = true;
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(options: DashScopeImageOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = `${options.serviceBase ?? DASHSCOPE_SERVICE_BASE}${MULTIMODAL_GENERATION_PATH}`;
  }

  async generate(
    input: ImageGenerationInput,
    signal?: AbortSignal,
  ): Promise<ImageGenerationResult> {
    const parameters: Record<string, unknown> = { watermark: false };
    const size = toNativeSize(input.size);
    if (size) parameters.size = size;

    // Phase B：参考图作为 image 内容块先行注入（qwen-image 图生图/编辑语义），
    // 无参考图时退化为纯文本（与旧行为一致）。
    const content: DashScopeContentPart[] = [];
    for (const url of input.referenceImageUrls ?? []) {
      if (url) content.push({ image: url });
    }
    content.push({ text: input.prompt });

    const body = {
      model: input.model,
      input: {
        messages: [{ role: "user", content }],
      },
      parameters,
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
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
        throw new Error("DashScope image request aborted", { cause: err });
      }
      throw new Error(`DashScope image request failed: ${(err as Error).message}`, { cause: err });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `DashScope image request failed (${response.status}${detail ? `: ${truncate(detail, 500)}` : ""})`,
      );
    }

    let json: DashScopeImageResponse;
    try {
      json = (await response.json()) as DashScopeImageResponse;
    } catch {
      throw new Error("DashScope image response is not valid JSON");
    }

    // 两种响应形态：qwen-image（choices[].message.content[].image）/ 万相（results[].url）
    const urls: string[] = [];
    for (const choice of json.output?.choices ?? []) {
      for (const part of choice.message?.content ?? []) {
        if (part.image) urls.push(part.image);
      }
    }
    for (const r of json.output?.results ?? []) {
      if (r.url) urls.push(r.url);
    }
    if (urls.length === 0) {
      const reason = json.code ?? json.message ?? json.request_id ?? "响应中无图片 URL";
      throw new Error(`DashScope image response contains no images (${truncate(String(reason), 200)})`);
    }
    return {
      images: urls.map((url) => ({ url })),
      raw: json,
    };
  }
}
