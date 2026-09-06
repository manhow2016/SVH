/**
 * 模型供应商目录与模型类型定义（V1：火山引擎 / 阿里云百炼，可扩展）。
 *
 * 模型由供应商提供，通过供应商 API Key 调用；模型按类型划分：
 * 文本 / 图片 / 视频 / 音频。
 *
 * 可用模型列表由管理员在后台维护（models 表），供应商目录只负责
 * 提供端点（baseUrl）等元数据，供前端展示与运行时装配。
 */

/** 模型类型（文本 / 图片 / 视频 / 音频） */
export type ModelType = "text" | "image" | "video" | "audio";

/** 模型类型展示元数据 */
export interface ModelTypeMeta {
  code: ModelType;
  label: string;
  description: string;
}

/** 供应商 API Key（用户按供应商配置，不同类型共用） */
export interface ProviderApiKey {
  apiKey: string;
}

/** 供应商元数据（内置目录，供前端展示） */
export interface ModelProviderMeta {
  id: string;
  name: string;
  /** OpenAI 兼容 base URL */
  baseUrl: string;
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
 * 因此统一走 OpenAICompatibleProvider 装配；可用模型列表见 models 表（管理员维护）。
 */
export const MODEL_PROVIDERS: ModelProviderMeta[] = [
  {
    id: "volcengine",
    name: "火山引擎",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    fixedEndpoint: true,
  },
  {
    id: "dashscope",
    name: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    fixedEndpoint: true,
  },
];

/** 按 id 查供应商元数据 */
export function getProviderMeta(id: string): ModelProviderMeta | undefined {
  return MODEL_PROVIDERS.find((p) => p.id === id);
}

/** 获取供应商的 base URL（固定端点取目录值） */
export function resolveProviderBaseUrl(provider: ModelProviderMeta): string {
  return provider.baseUrl;
}

/**
 * 运行时调用端点解析（普通聊天 / 技能共用）：
 * - 用户配置了该供应商 API Key → 直达供应商真实端点（调用用户自己的供应商账号，
 *   与 API Key 校验策略一致，不使用 env 端点覆盖）；
 * - 未配置 Key（env 兜底形态：内网网关 / mock 模拟）→ 优先 env 默认端点，否则供应商目录端点。
 */
export function resolveRuntimeBaseUrl(
  provider: ModelProviderMeta,
  options: { userApiKey?: string; envBaseUrl: string },
): string {
  if (options.userApiKey) return provider.baseUrl;
  if (options.envBaseUrl !== "") return options.envBaseUrl;
  return provider.baseUrl;
}
