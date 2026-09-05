import type { FastifyInstance } from "fastify";
import type { SettingsService } from "../modules/settings/service";
import type { ProviderApiKey, ModelTypeConfig, ModelType } from "../modules/settings/model-catalog";
import { getProviderMeta } from "../modules/settings/model-catalog";
import { ERRORS } from "../lib/errors";

export interface SettingsRouteDeps {
  settingsService: SettingsService;
}

const MODEL_TYPES: ModelType[] = ["text", "image", "video", "audio"];

/**
 * Settings API（文档 §45）：API Key 服务端存储，不直出明文；按用户隔离（§37）。
 *
 * GET  /api/settings        模型设置（供应商 API Key 掩码 + 类型模型选择）+ 目录元数据
 * PUT  /api/settings        更新模型设置（局部更新：providers / models）
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  // 读取（目录 + 用户设置，ApiKey 仅返回掩码 hasApiKey）
  app.get("/api/settings", async (req) => ({
    catalog: deps.settingsService.catalog(),
    models: await deps.settingsService.getPublicModelSettings(req.user!.userId),
  }));

  // 更新并持久化
  app.put<{
    Body: {
      providers?: Record<string, Partial<ProviderApiKey>>;
      models?: Partial<Record<ModelType, Partial<ModelTypeConfig>>>;
    };
  }>("/api/settings", async (req, reply) => {
    const body = req.body ?? {};
    if (body.providers !== undefined && typeof body.providers !== "object") {
      throw ERRORS.INVALID_INPUT("providers must be an object");
    }
    if (body.models !== undefined && typeof body.models !== "object") {
      throw ERRORS.INVALID_INPUT("models must be an object");
    }

    // 校验供应商 API Key：仅允许存在的供应商
    for (const [id, v] of Object.entries(body.providers ?? {})) {
      if (!getProviderMeta(id)) throw ERRORS.INVALID_INPUT(`unknown provider: ${id}`);
      if (v?.apiKey !== undefined && typeof v.apiKey !== "string") {
        throw ERRORS.INVALID_INPUT(`providers.${id}.apiKey must be a string`);
      }
      if (v?.baseUrl !== undefined && typeof v.baseUrl !== "string") {
        throw ERRORS.INVALID_INPUT(`providers.${id}.baseUrl must be a string`);
      }
    }

    // 校验模型类型配置
    for (const [type, v] of Object.entries(body.models ?? {}) as Array<
      [string, Partial<ModelTypeConfig>]
    >) {
      if (!MODEL_TYPES.includes(type as ModelType)) {
        throw ERRORS.INVALID_INPUT(`unknown model type: ${type}`);
      }
      const providerId = v?.provider;
      if (providerId !== undefined) {
        if (!getProviderMeta(providerId)) {
          throw ERRORS.INVALID_INPUT(`unknown provider: ${providerId}`);
        }
      }
      if (v?.model !== undefined && (typeof v.model !== "string" || v.model.trim() === "")) {
        throw ERRORS.INVALID_INPUT(`models.${type}.model must be a non-empty string`);
      }
    }

    await deps.settingsService.updateModelSettings(req.user!.userId, body);
    return reply.code(200).send({
      models: await deps.settingsService.getPublicModelSettings(req.user!.userId),
    });
  });
}
