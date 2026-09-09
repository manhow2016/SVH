/**
 * DashScope（阿里云百炼）文生图适配器。
 *
 * 百炼图片模型**不提供** OpenAI 兼容的 `/images/generations` 端点（实测 404），
 * 使用 DashScope 原生同步接口。不同模型族**端点不可混用**（实测：把 wan 系列
 * 发到 multimodal-generation 会得到 400 `url error`）：
 *
 * - qwen-image 系列 → 多模态生成（multimodal-generation）：
 *     POST {serviceBase}/services/aigc/multimodal-generation/generation
 *     body: { model, input: { messages: [{ role, content: [{ text }|{ image }] }] }, parameters }
 *     resp: { output: { choices: [{ message: { content: [{ image: "url" }] } }] } }
 * - 万相（wanx/wan）文生图 → 同步文生图（text2image）：
 *     POST {serviceBase}/services/aigc/text2image/image-synthesis
 *     body: { model, input: { prompt }, parameters: { size, watermark } }
 *     resp: { output: { results: [{ url }] } }
 *
 * 输出统一映射到 ImageGenerationResult（url 形态；两种响应解析共用）。
 */
import type {
  ImageGenerationInput,
  ImageGenerationResult,
  ImageProvider,
} from "./provider";
import { DASHSCOPE_SERVICE_BASE } from "../video/dashscope";
import { buildAuthHeaders, isAbortError, truncate } from "../http";

const MULTIMODAL_GENERATION_PATH = "/services/aigc/multimodal-generation/generation";
const TEXT2IMAGE_PATH = "/services/aigc/text2image/image-synthesis";

/** qwen-image 系列走多模态端点；其余（wan/wanx 万相）走同步文生图端点 */
function isQwenImageModel(model: string): boolean {
  return /^qwen-image/i.test(model.trim());
}

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

/** 参考图仅接受 http(s) 公开 URL（本地文件路径/内网地址注入会触发 url error） */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

export class DashScopeImageProvider implements ImageProvider {
  readonly id = "dashscope-image";
  /**
   * 多模态（qwen-image）支持 image 内容块（参考图 → 图生图/角色参照），Phase B；
   * 万相同步文生图不支持参考图注入（自动降级 prompt-only）。
   */
  readonly referenceImageSupport = true;
  private readonly apiKey: string;
  private readonly multimodalEndpoint: string;
  private readonly text2imageEndpoint: string;

  constructor(options: DashScopeImageOptions) {
    const base = options.serviceBase ?? DASHSCOPE_SERVICE_BASE;
    this.apiKey = options.apiKey;
    this.multimodalEndpoint = `${base}${MULTIMODAL_GENERATION_PATH}`;
    this.text2imageEndpoint = `${base}${TEXT2IMAGE_PATH}`;
  }

  async generate(
    input: ImageGenerationInput,
    signal?: AbortSignal,
  ): Promise<ImageGenerationResult> {
    // 按模型族路由端点（qwen-image ↔ multimodal；wan/wanx ↔ text2image）
    const endpoint = isQwenImageModel(input.model)
      ? this.multimodalEndpoint
      : this.text2imageEndpoint;

    const parameters: Record<string, unknown> = { watermark: false };
    const size = toNativeSize(input.size);
    if (size) parameters.size = size;

    let body: Record<string, unknown>;
    if (isQwenImageModel(input.model)) {
      // 参考图作为 image 内容块先行注入（qwen-image 图生图/编辑语义）；
      // 非 http(s) 值（本地文件）一律丢弃，避免 DashScope url error。
      const content: DashScopeContentPart[] = [];
      for (const url of input.referenceImageUrls ?? []) {
        if (url && isHttpUrl(url)) content.push({ image: url });
      }
      content.push({ text: input.prompt });
      body = {
        model: input.model,
        input: {
          messages: [{ role: "user", content }],
        },
        parameters,
      };
    } else {
      // 万相：同步文生图（input.prompt 形态；参考图不支持，降级 prompt-only）
      body = {
        model: input.model,
        input: { prompt: input.prompt },
        parameters,
      };
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
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
