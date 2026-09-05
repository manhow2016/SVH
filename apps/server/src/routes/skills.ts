import type { FastifyInstance } from "fastify";
import type { SkillRunService } from "../modules/skills/skill-run-service";
import { listSkillPublicViews } from "../modules/skills/definitions";
import { ERRORS } from "../lib/errors";

export interface SkillsRouteDeps {
  skillRunService: SkillRunService;
}

/** 技能 API：列表 + 执行（SSE，事件协议同 Agent run） */
export function registerSkillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  // 技能列表（公开视图，不含提示词模板）
  app.get("/api/skills", async () => listSkillPublicViews());

  // 技能执行
  app.post<{
    Params: { id: string };
    Body: { skillId?: string; params?: Record<string, unknown>; modelName?: string };
  }>("/api/sessions/:id/skill", async (req, reply) => {
    // 类型守卫：非字符串（如数字）按缺失处理，避免 trim 抛 TypeError 导致 500
    const skillIdRaw = req.body?.skillId;
    const skillId = typeof skillIdRaw === "string" ? skillIdRaw.trim() : "";
    if (!skillId) {
      throw ERRORS.INVALID_INPUT("skillId is required");
    }
    await deps.skillRunService.streamRun(
      req.params.id,
      skillId,
      req.body?.params ?? {},
      req.body?.modelName,
      req.user!.userId,
      req,
      reply,
    );
  });
}
