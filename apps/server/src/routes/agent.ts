import type { FastifyInstance } from "fastify";
import type { AgentRunService } from "../modules/agent/run-service";
import { AGENT_PROFILES } from "../modules/agent/profiles";
import { ERRORS } from "../lib/errors";

export interface AgentRouteDeps {
  runService: AgentRunService;
}

/** Agent Run API（文档 §30）：POST /api/sessions/:id/run → text/event-stream */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  // Agent 角色列表（前端角色选择器数据源；仅暴露公开信息）
  app.get("/api/agent/profiles", async () =>
    AGENT_PROFILES.map((p) => ({ id: p.id, name: p.name, description: p.description })),
  );

  app.post<{ Params: { id: string }; Body: { message?: string; profileId?: string } }>(
    "/api/sessions/:id/run",
    async (req, reply) => {
      const message = req.body?.message?.trim();
      if (!message) {
        throw ERRORS.INVALID_INPUT("message is required");
      }
      await deps.runService.streamRun(
        req.params.id,
        message,
        req.user!.userId,
        req,
        reply,
        req.body?.profileId,
      );
    },
  );
}
