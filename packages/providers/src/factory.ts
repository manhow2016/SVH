/**
 * 生成供应商路由工厂（spec §4.2/§5）：按目录 providerId 选择具体适配器实现。
 * 当前唯一消费方为 apps/worker（任务执行）；server 已改为纯入队、零 provider
 * 调用（Task 6），保留在本包是共享契约位置，杜绝未来两侧路由漂移。
 */
import type { ModelConfig } from "./llm/provider";
import type { ImageProvider } from "./image/provider";
import type { VideoProvider } from "./video/provider";
import { DashScopeImageProvider } from "./image/dashscope";
import { OpenAICompatibleImageProvider } from "./image/openai-compatible";
import { DashScopeVideoProvider } from "./video/dashscope";

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
