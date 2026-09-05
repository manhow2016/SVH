import type { FastifyReply, FastifyRequest } from "fastify";
import type { MessageMetadata } from "@svh/database";
import { OpenAICompatibleProvider, type ChatMessage, type ProviderRegistry } from "@svh/providers";
import type { SessionService } from "../session/service";
import type { WorkspaceService } from "../workspace/service";
import type { SettingsService } from "../settings/service";
import type { MembershipService } from "../membership/service";
import type { ModelType } from "../settings/model-catalog";
import { ERRORS } from "../../lib/errors";
import { writeSSE } from "../../lib/sse";
import { getSkillById, renderSkillPrompt, validateSkillParams, type SkillResultKind } from "./definitions";

export interface SkillRunDeps {
  sessionService: SessionService;
  workspaceService: WorkspaceService;
  settingsService: SettingsService;
  membershipService: MembershipService;
  providerRegistry: ProviderRegistry;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/** 技能消息元数据（写入 messages.metadata.skill） */
export interface SkillMessageMeta {
  skillId: string;
  skillName: string;
  params: Record<string, string | number>;
  modelName: string;
  resultKind: SkillResultKind;
}

/**
 * 技能执行服务：校验 → 模型解析 → 单轮 LLM 补全（无 Tools / 无历史）
 * → 消息持久化 → SSE 转发。事件协议复用 AgentEvent（message.* / run.*）。
 */
export class SkillRunService {
  constructor(private readonly deps: SkillRunDeps) {}

  async streamRun(
    sessionId: string,
    skillId: string,
    params: Record<string, unknown>,
    modelName: string | undefined,
    userId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // ---- 前置校验（错误走 JSON 响应） ----
    await this.deps.membershipService.assertFeature(userId, "agent.basic");
    const session = await this.deps.sessionService.get(sessionId);
    if (session.status === "running") {
      throw ERRORS.SESSION_RUNNING();
    }
    await this.deps.workspaceService.getOwned(session.workspaceId, userId);

    const skill = getSkillById(skillId);
    if (!skill) {
      throw ERRORS.INVALID_INPUT(`技能不存在：${skillId}`);
    }
    const normalized = validateSkillParams(skill, params ?? {});
    const modelConfig = await this.deps.settingsService.getSkillModelConfig(
      modelName?.trim() || undefined,
      userId,
      skill.modelTypes as ModelType[],
    );
    const userPrompt = renderSkillPrompt(skill, normalized);

    // ---- 持久化用户消息（技能标记，内容为主参数原文或摘要） ----
    const primary = skill.params.find((p) => p.primary);
    const primaryValue = primary ? normalized[primary.key] : undefined;
    const userContent =
      typeof primaryValue === "string" && primaryValue !== ""
        ? primaryValue
        : `「${skill.name}」技能执行`;
    const meta: SkillMessageMeta = {
      skillId: skill.id,
      skillName: skill.name,
      params: normalized,
      modelName: modelConfig.model,
      resultKind: skill.resultKind,
    };
    await this.deps.sessionService.addUserMessage(sessionId, userContent, {
      skill: meta,
    } as MessageMetadata);

    // ---- 状态流转：Idle → Running ----
    await this.deps.sessionService.setStatus(sessionId, "running");
    this.deps.providerRegistry.register(
      new OpenAICompatibleProvider({ baseUrl: modelConfig.baseUrl, apiKey: modelConfig.apiKey }),
    );

    this.deps.log.info(
      { sessionId, skill: skill.id, model: modelConfig.model },
      "skill run started",
    );

    // ---- SSE 流 ----
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const controller = new AbortController();
    const onClose = () => controller.abort();
    request.raw.on("close", onClose);

    let terminalError = false;
    let assistantContent = "";
    const messageId = `skill_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    try {
      writeSSE(raw, { type: "run.started" });
      writeSSE(raw, { type: "message.started", messageId });

      const provider = this.deps.providerRegistry.get(modelConfig.providerId);
      const messages: ChatMessage[] = [
        ...(skill.systemPrompt ? [{ role: "system" as const, content: skill.systemPrompt }] : []),
        { role: "user", content: userPrompt },
      ];

      for await (const event of provider.chat(
        { model: modelConfig.model, messages },
        controller.signal,
      )) {
        if (event.type === "delta") {
          assistantContent += event.content;
          writeSSE(raw, { type: "message.delta", messageId, content: event.content });
        } else if (event.type === "done") {
          break;
        } else if (event.type === "error") {
          terminalError = true;
          writeSSE(raw, { type: "message.completed", messageId });
          writeSSE(raw, { type: "run.error", error: event.error });
          this.deps.log.error({ sessionId, skill: skill.id, error: event.error }, "skill run error");
          break;
        }
      }

      if (!terminalError) {
        await this.deps.sessionService.addAssistantMessage(sessionId, assistantContent, {
          skill: meta,
        } as MessageMetadata);
        writeSSE(raw, { type: "message.completed", messageId });
        writeSSE(raw, { type: "run.completed" });
        this.deps.log.info({ sessionId, skill: skill.id }, "skill run completed");
      }
    } catch (err) {
      this.deps.log.error({ sessionId, skill: skill.id, error: (err as Error).message }, "skill run relay error");
    } finally {
      request.raw.removeListener("close", onClose);
      await this.deps.sessionService.setStatus(sessionId, terminalError ? "error" : "idle");
      if (!raw.destroyed) {
        try {
          raw.end();
        } catch {
          // 客户端已断开，忽略
        }
      }
    }
  }
}
