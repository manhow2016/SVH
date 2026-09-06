import type { FastifyInstance } from "fastify";
import type { SettingsService } from "../modules/settings/service";
import type { ProviderApiKey } from "../modules/settings/model-catalog";
import { getProviderMeta } from "../modules/settings/model-catalog";
import { ERRORS } from "../lib/errors";

export interface SettingsRouteDeps {
  settingsService: SettingsService;
}

/**
 * Settings API（文档 §45）：API Key / 用户启用模型 服务端存储，不直出明文；按用户隔离（§37）。
 *
 * GET  /api/settings        模型设置视图（供应商 API Key 掩码 + 可用模型列表 + 用户启用列表）
 * PUT  /api/settings        更新供应商 API Key / 用户启用模型列表（局部更新；留空字段不修改）
 * POST /api/settings/verify 验证供应商 API Key（探测 /models，必要时降级最小 chat 请求）
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  // 读取（供应商掩码 + 可用模型列表；ApiKey 仅返回 hasApiKey）
  app.get("/api/settings", async (req) => deps.settingsService.getSettingsView(req.user!.userId));

  // 更新并持久化（供应商 API Key / 用户启用模型列表）
  app.put<{
    Body: {
      providers?: Record<string, Partial<ProviderApiKey>>;
      enabledModels?: string[] | null;
    };
  }>("/api/settings", async (req, reply) => {
    const body = req.body ?? {};
    if (body.providers !== undefined && typeof body.providers !== "object") {
      throw ERRORS.INVALID_INPUT("providers must be an object");
    }
    if (body.enabledModels !== undefined && !Array.isArray(body.enabledModels)) {
      throw ERRORS.INVALID_INPUT("enabledModels must be an array");
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

  // 验证供应商 API Key（不改动设置；apiKey 可选：传入则验证草稿 Key，否则验证已保存 Key）
  app.post<{
    Body: { providerId?: unknown; apiKey?: unknown };
  }>("/api/settings/verify", async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.providerId !== "string") {
      throw ERRORS.INVALID_INPUT("providerId must be a string");
    }
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
      throw ERRORS.INVALID_INPUT("apiKey must be a string");
    }
    const result = await deps.settingsService.verifyProviderKey(
      req.user!.userId,
      body.providerId,
      body.apiKey,
    );
    return reply.code(200).send(result);
  });
}
