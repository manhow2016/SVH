/**
 * 模型供应商目录与模型类型定义（V1：火山引擎 / 阿里云百炼，可扩展）。
 *
 * 模型由供应商提供，通过供应商 API Key 调用；模型按类型划分：
 * 文本 / 图片 / 视频 / 音频。目录数据用于前端展示与后端装配（baseUrl 等）。
 */

/** 模型类型（文本 / 图片 / 视频 / 音频） */
export type ModelType = "text" | "image" | "video" | "audio";

/** 模型类型展示元数据 */
export interface ModelTypeMeta {
  code: ModelType;
  label: string;
  description: string;
}

/** 每个类型的供应商配置（V1：固定结构，后续可扩展为多供应商 per 类型） */
export interface ModelTypeConfig {
  provider: string;
  model: string;
}

/** 供应商 API Key（用户按供应商配置，不同类型共用） */
export interface ProviderApiKey {
  apiKey: string;
  /** 自定义供应商的 base URL（内置供应商使用固定 endpoint） */
  baseUrl?: string;
}

/** 供应商元数据（内置目录，供前端展示） */
export interface ModelProviderMeta {
  id: string;
  name: string;
  /** OpenAI 兼容 base URL（custom 为空，由用户填写） */
  baseUrl: string;
  /** 该供应商在各类型下的推荐模型（V1 目录，可配置） */
  models: Record<ModelType, string[]>;
  /** 是否固定端点（固定端点 = 使用目录内 baseUrl；否则按用户配置的 baseUrl 调用） */
  fixedEndpoint: boolean;
}

/** 模型类型定义（V1 四种） */
export const MODEL_TYPES: ModelTypeMeta[] = [
  { code: "text", label: "文本模型", description: "对话 / 推理 / 写作" },
  { code: "image", label: "图片模型", description: "文生图 / 图生图 / 设计" },
  { code: "video", label: "视频模型", description: "文生视频 / 图生视频" },
  { code: "audio", label: "音频模型", description: "语音合成 / 语音识别" },
];

/**
 * 供应商目录。
 *
 * 火山引擎方舟（Volcano Ark）与阿里云百炼（DashScope）均提供 OpenAI 兼容接口，
 * 因此统一走 OpenAICompatibleProvider 装配；模型清单为 V1 推荐目录，
 * 列表中模型均可按供应商文档增补（前端允许手动输入任意模型名）。
 */
export const MODEL_PROVIDERS: ModelProviderMeta[] = [
  {
    id: "volcengine",
    name: "火山引擎",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    fixedEndpoint: true,
    models: {
      text: [
        "doubao-seed-1-6-250615",
        "doubao-1-5-pro-32k-250115",
        "deepseek-v3-250528",
      ],
      image: ["doubao-seedream-4-0-250828", "doubao-seedream-3-0-t2i-250415"],
      video: ["doubao-seedance-1-0-pro-250528", "doubao-seedance-1-0-lite-250528"],
      audio: ["doubao-tts", "doubao-asr"],
    },
  },
  {
    id: "dashscope",
    name: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    fixedEndpoint: true,
    models: {
      text: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max"],
      image: ["wanx2.1-t2i-turbo", "qwen-image"],
      video: ["wanx2.1-i2v-turbo", "wanx2.1-t2v-turbo"],
      audio: ["qwen-tts", "cosyvoice-v2"],
    },
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    baseUrl: "",
    fixedEndpoint: false,
    models: {
      text: [],
      image: [],
      video: [],
      audio: [],
    },
  },
];

/** 按 id 查供应商元数据 */
export function getProviderMeta(id: string): ModelProviderMeta | undefined {
  return MODEL_PROVIDERS.find((p) => p.id === id);
}

/** 获取供应商的 base URL（固定端点取目录值；自定义取用户配置） */
export function resolveProviderBaseUrl(
  provider: ModelProviderMeta,
  customBaseUrl?: string,
): string {
  return provider.fixedEndpoint ? provider.baseUrl : (customBaseUrl ?? "");
}
