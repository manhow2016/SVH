import type { FastifyInstance } from "fastify";
import type { AgentRunService } from "../modules/agent/run-service";
import { ERRORS } from "../lib/errors";

export interface AgentRouteDeps {
  runService: AgentRunService;
}

/** Agent Run API（文档 §30）：POST /api/sessions/:id/run → text/event-stream */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/api/sessions/:id/run",
    async (req, reply) => {
      const message = req.body?.message?.trim();
      if (!message) {
        throw ERRORS.INVALID_INPUT("message is required");
      }
      await deps.runService.streamRun(req.params.id, message, req.user!.userId, req, reply);
    },
  );
}
