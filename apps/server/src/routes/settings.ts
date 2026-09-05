import type { FastifyInstance } from "fastify";
import type { SettingsService } from "../modules/settings/service";
import { ERRORS } from "../lib/errors";

export interface SettingsRouteDeps {
  settingsService: SettingsService;
}

/** Settings API（文档 §45）：ApiKey 服务端存储，不直出；按用户隔离（§37） */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  // 读取（ApiKey 掩码为 hasApiKey）
  app.get("/api/settings", async (req) => ({
    llm: await deps.settingsService.getPublicLLM(req.user!.userId),
  }));

  // 更新并持久化
  app.put<{ Body: { llm: { baseUrl?: string; apiKey?: string; model?: string } } }>(
    "/api/settings",
    async (req, reply) => {
      const llm = req.body?.llm;
      if (!llm) throw ERRORS.INVALID_INPUT("llm settings are required");
      if (llm.baseUrl !== undefined && typeof llm.baseUrl !== "string") {
        throw ERRORS.INVALID_INPUT("llm.baseUrl must be a string");
      }
      if (llm.apiKey !== undefined && typeof llm.apiKey !== "string") {
        throw ERRORS.INVALID_INPUT("llm.apiKey must be a string");
      }
      if (llm.model !== undefined && typeof llm.model !== "string") {
        throw ERRORS.INVALID_INPUT("llm.model must be a string");
      }
      await deps.settingsService.updateLLM(req.user!.userId, llm);
      return reply.code(200).send({
        llm: await deps.settingsService.getPublicLLM(req.user!.userId),
      });
    },
  );
}
