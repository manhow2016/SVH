import type { FastifyInstance } from "fastify";
import type { SettingsService } from "../modules/settings/service";
import type { ProviderApiKey } from "../modules/settings/model-catalog";
import { getProviderMeta } from "../modules/settings/model-catalog";
import { ERRORS } from "../lib/errors";

export interface SettingsRouteDeps {
  settingsService: SettingsService;
}

/**
 * Settings API（文档 §45）：API Key 服务端存储，不直出明文；按用户隔离（§37）。
 *
 * GET  /api/settings        模型设置视图（供应商 API Key 掩码 + 各供应商可用模型列表）
 * PUT  /api/settings        更新供应商 API Key（局部更新；留空字段不修改）
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  // 读取（供应商掩码 + 可用模型列表；ApiKey 仅返回 hasApiKey）
  app.get("/api/settings", async (req) => deps.settingsService.getSettingsView(req.user!.userId));

  // 更新并持久化（仅供应商 API Key）
  app.put<{
    Body: {
      providers?: Record<string, Partial<ProviderApiKey>>;
    };
  }>("/api/settings", async (req, reply) => {
    const body = req.body ?? {};
    if (body.providers !== undefined && typeof body.providers !== "object") {
      throw ERRORS.INVALID_INPUT("providers must be an object");
    }

    // 校验供应商 API Key：仅允许存在的供应商
    for (const [id, v] of Object.entries(body.providers ?? {})) {
      if (!getProviderMeta(id)) throw ERRORS.INVALID_INPUT(`unknown provider: ${id}`);
      if (v?.apiKey !== undefined && typeof v.apiKey !== "string") {
        throw ERRORS.INVALID_INPUT(`providers.${id}.apiKey must be a string`);
      }
    }

    await deps.settingsService.updateModelSettings(req.user!.userId, body);
    return reply.code(200).send(await deps.settingsService.getSettingsView(req.user!.userId));
  });
}
