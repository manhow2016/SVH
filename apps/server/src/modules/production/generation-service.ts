/**
 * 生成服务（V0.2 文档 §13：Storyboard → Image Prompt → Image Generation → Asset）。
 *
 * 职责：解析用户/环境模型配置（复用 settings 解析优先级）
 * → 调用 Image Provider → 生成结果落库为生产资产（追踪来源 generation）。
 */
import { OpenAICompatibleImageProvider } from "@svh/providers";
import type { ProductionService } from "@svh/production";
import type { SettingsService } from "../settings/service";
import { ERRORS } from "../../lib/errors";

export interface GenerationServiceDeps {
  settings: SettingsService;
  production: ProductionService;
}

export class GenerationService {
  constructor(private readonly deps: GenerationServiceDeps) {}

  /** 文生图（第一阶段：OpenAI 兼容图片端点；结果存供应商 URL，无 URL 时 b64 放 metadata） */
  async generateImage(input: {
    projectId: string;
    userId: string;
    prompt: string;
    modelName?: string;
    size?: string;
  }): Promise<unknown> {
    const prompt = input.prompt.trim();
    if (prompt === "") {
      throw ERRORS.INVALID_INPUT("prompt is required");
    }
    // 复用 settings 解析：类型 image → 显式 modelName 或默认启用图片模型
    const modelConfig = await this.deps.settings.getSkillModelConfig(
      input.modelName,
      input.userId,
      ["image"],
    );
    if (!modelConfig.model) {
      throw ERRORS.INVALID_INPUT("未配置可用的图片模型，请在 Settings 中启用图片模型");
    }

    const provider = new OpenAICompatibleImageProvider({
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
    });
    const result = await provider.generate({
      model: modelConfig.model,
      prompt,
      size: input.size,
    });
    const first = result.images[0];
    if (!first) {
      throw ERRORS.INVALID_INPUT("图片生成失败：供应商未返回图片");
    }

    const asset = await this.deps.production.createAsset({
      projectId: input.projectId,
      type: "image",
      name: prompt.slice(0, 40) || "生成图片",
      url: first.url,
      mimeType: "image/png",
      metadata: first.b64Json ? { b64Json: first.b64Json } : undefined,
      generation: {
        providerId: "openai-compatible",
        modelId: modelConfig.model,
        prompt,
      },
    });
    return { asset, created: result.created };
  }
}
