/**
 * Image Provider 接口（V0.2 文档 §13.2）。
 *
 * 第一阶段实现 OpenAI Compatible Image API；后续可扩展 DashScope / 自定义 HTTP Provider。
 */
export interface ImageGenerationInput {
  model: string;
  prompt: string;
  /** 生成数量（默认为 1） */
  n?: number;
  /** 尺寸，如 "1024x1024" */
  size?: string;
  /** 响应格式：url | b64_json（默认为 url） */
  responseFormat?: "url" | "b64_json";
  seed?: number;
  /**
   * 参考图 URL（角色一致性，Phase B）：有能力的适配器按图生图/参照注入；
   * 无能力的适配器忽略该字段（仅 prompt 降级，不报错）。
   */
  referenceImageUrls?: string[];
}

export interface ImageGenerationResultImage {
  url?: string;
  b64Json?: string;
  /** 修订后的提示词（部分供应商返回） */
  revisedPrompt?: string;
}

export interface ImageGenerationResult {
  images: ImageGenerationResultImage[];
  created?: number;
  /** 供应商原始响应（调试/追踪用，可省略） */
  raw?: unknown;
}

export interface ImageProvider {
  /** 统一注册 id（如 "openai-compatible-image"） */
  id: string;
  /**
   * 是否支持参考图输入（图生图/角色参照）。
   * 缺省 false：调用方不应在无法确认支持时把参考图塞给供应商（回退 prompt-only）。
   */
  readonly referenceImageSupport?: boolean;
  generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<ImageGenerationResult>;
}
