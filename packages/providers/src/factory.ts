/**
 * 生成供应商路由工厂（spec §4.2/§5）：按目录 providerId 选择具体适配器实现。
 * 生成域唯一消费方为 apps/worker（任务执行）；server 在生成域已改为纯入队、
 * 零 provider 调用（Task 6）——注意 LLM 对话侧 server 仍消费 @svh/providers。
 * 保留在本包是共享契约位置，杜绝未来两侧路由漂移。
 */
import type { ModelConfig } from "./llm/provider";
import type { ImageProvider } from "./image/provider";
import type { VideoProvider } from "./video/provider";
import { DashScopeImageProvider } from "./image/dashscope";
import { OpenAICompatibleImageProvider } from "./image/openai-compatible";
import { DashScopeVideoProvider } from "./video/dashscope";
import { OpenAICompatibleTTSService } from "./tts/openai-compatible";
import type { TTSService } from "./tts/provider";

/** 图片：百炼走 DashScope 原生同步接口，其余走 OpenAI 兼容 /images/generations */
export function createImageProvider(input: {
  providerId: string;
  config: ModelConfig;
}): ImageProvider {
  if (input.providerId === "dashscope") {
    return new DashScopeImageProvider({ apiKey: input.config.apiKey });
  }
  return new OpenAICompatibleImageProvider({
    baseUrl: input.config.baseUrl,
    apiKey: input.config.apiKey,
  });
}

/** 视频：当前仅支持百炼异步任务 */
export function createVideoProvider(input: {
  providerId: string;
  config: ModelConfig;
}): VideoProvider {
  if (input.providerId !== "dashscope") {
    throw new Error("当前版本视频生成仅支持百炼（DashScope）模型");
  }
  return new DashScopeVideoProvider({ apiKey: input.config.apiKey });
}

/**
 * TTS：统一走 OpenAI Compatible /v1/audio/speech（Phase C）。
 * 需所配网关支持该端点（如 OpenAI 官方或兼容 TTS 网关）；providerId 仅作区分（当前通用）。
 */
export function createTTSService(input: { providerId: string; config: ModelConfig }): TTSService {
  return new OpenAICompatibleTTSService({
    baseUrl: input.config.baseUrl,
    apiKey: input.config.apiKey,
  });
}
