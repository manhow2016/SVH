import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentRuntime } from "@svh/core";
import type { MessageMetadata } from "@svh/database";
import { OpenAICompatibleProvider, type ProviderRegistry } from "@svh/providers";
import type { SessionService } from "../session/service";
import type { WorkspaceService } from "../workspace/service";
import type { SettingsService } from "../settings/service";
import type { MembershipService } from "../membership/service";
import { getProfileById } from "./profiles";
import { extractCreatedProjectId } from "./auto-pipeline";
import type { AutoPipelineService } from "./auto-pipeline";
import { ERRORS } from "../../lib/errors";
import { isErrorOutput, writeSSE } from "../../lib/sse";

export interface AgentRunDeps {
  runtime: AgentRuntime;
  sessionService: SessionService;
  workspaceService: WorkspaceService;
  settingsService: SettingsService;
  membershipService: MembershipService;
  providerRegistry: ProviderRegistry;
  /** Chat → Workflow 自动串联（可选注入；Director 建项目后自动启动生产工作流） */
  autoPipeline?: AutoPipelineService;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Agent Run 服务：编排「会话校验 → 状态流转 → Runtime 事件流 → SSE 转发 → 消息持久化」。
 *
 * 注意：所有校验必须在 reply.hijack() 之前完成，否则错误无法以 JSON 返回。
 */
export class AgentRunService {
  constructor(private readonly deps: AgentRunDeps) {}

  async streamRun(
    sessionId: string,
    message: string,
    userId: string,
    request: FastifyRequest,
    reply: FastifyReply,
    profileId?: string,
  ): Promise<void> {
    // ---- 前置校验（错误走 JSON 响应） ----
    // 会员功能权限：Agent 必须接入会员系统（文档 §19，后端验证，禁止前端代替）
    await this.deps.membershipService.assertFeature(userId, "agent.basic");
    // Agent Profile：未知角色 id 直接拒绝（不进入 Stream）
    const profile = profileId ? getProfileById(profileId) : undefined;
    if (profileId && !profile) {
      throw ERRORS.INVALID_INPUT(`Agent 角色不存在：${profileId}`);
    }
    const session = await this.deps.sessionService.get(sessionId);
    if (session.status === "running") {
      throw ERRORS.SESSION_RUNNING();
    }
    // 所有权校验：Agent 只能基于当前用户的会话执行（文档 §20/§37，其他用户会话一律不存在）
    await this.deps.workspaceService.getOwned(session.workspaceId, userId);
    const modelConfig = await this.deps.settingsService.getEffectiveModelConfig(session, userId);
    if (modelConfig.model.trim() === "") {
      throw ERRORS.INVALID_INPUT("请先在 Settings 中配置模型（SVH_LLM_MODEL）");
    }

    // ---- 状态流转：Idle → Running ----
    // 用户消息由 ContextBuilder 在构建上下文时持久化（避免与历史消息重复）
    await this.deps.sessionService.setStatus(sessionId, "running");

    // 按当前配置刷新 Provider（保证 Settings 修改即时生效）
    this.deps.providerRegistry.register(
      new OpenAICompatibleProvider({
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
      }),
    );

    this.deps.log.info(
      { sessionId, workspaceId: session.workspaceId, model: modelConfig.model },
      "agent run started",
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
    let runFinished = false;
    let assistantContent: string | null = null;
    let pendingAssistantId: string | null = null;
    const toolInputs = new Map<string, unknown>();
    // Chat → Workflow 串联：收集本次 Run 成功创建的 projectId
    const createdProjectIds: string[] = [];

    try {
      for await (const event of this.deps.runtime.run(
        {
          sessionId,
          workspaceId: session.workspaceId,
          userMessage: message,
          modelConfig,
          profile,
        },
        controller.signal,
      )) {
        // ---- 消息持久化（在转发前完成，保证刷新后可恢复） ----
        switch (event.type) {
          case "message.started":
            assistantContent = "";
            pendingAssistantId = null;
            break;
          case "message.delta":
            assistantContent = (assistantContent ?? "") + event.content;
            break;
          case "message.completed": {
            if (assistantContent !== null) {
              const row = await this.deps.sessionService.addAssistantMessage(
                sessionId,
                assistantContent,
                {
                  toolCalls: [],
                },
              );
              pendingAssistantId = row.id;
            }
            break;
          }
          case "tool.called": {
            toolInputs.set(event.toolCallId, event.input);
            if (pendingAssistantId) {
              await this.deps.sessionService.addToolCallToAssistant(sessionId, pendingAssistantId, {
                id: event.toolCallId,
                name: event.toolName,
                arguments: JSON.stringify(event.input ?? {}),
              });
            }
            this.deps.log.info(
              { sessionId, tool: event.toolName, toolCallId: event.toolCallId },
              "tool called",
            );
            break;
          }
          case "tool.completed": {
            const input = toolInputs.get(event.toolCallId);
            const meta: MessageMetadata = { toolName: event.toolName, input, output: event.output };
            if (isErrorOutput(event.output)) meta.error = true;
            await this.deps.sessionService.addToolMessage(sessionId, meta, event.toolCallId);
            toolInputs.delete(event.toolCallId);
            // Director 成功创建项目 → 记录（run 结束后自动启动工作流）
            const createdProjectId = extractCreatedProjectId(event.toolName, event.output);
            if (createdProjectId) createdProjectIds.push(createdProjectId);
            this.deps.log.info(
              { sessionId, tool: event.toolName, toolCallId: event.toolCallId, error: meta.error },
              "tool completed",
            );
            break;
          }
          case "run.completed":
            runFinished = true;
            this.deps.log.info({ sessionId }, "agent run completed");
            break;
          case "run.error":
            terminalError = true;
            this.deps.log.error({ sessionId, error: event.error }, "agent run error");
            break;
          default:
            break;
        }
        writeSSE(raw, event);
      }
    } catch (err) {
      // 中继本身出错（如客户端断开）：记录但不抛到上层导致崩溃
      this.deps.log.error({ sessionId, error: (err as Error).message }, "agent run relay error");
    } finally {
      request.raw.removeListener("close", onClose);
      const finalStatus = terminalError ? "error" : "idle";
      await this.deps.sessionService.setStatus(sessionId, finalStatus);
      if (!raw.destroyed) {
        try {
          raw.end();
        } catch {
          // 客户端已断开，忽略
        }
      }
      // ---- Chat → Workflow 自动串联 ----
      // Director 本次成功建项且 Run 正常结束（run.completed，非中断/错误）
      // → 自动创建并启动生产工作流。
      // maybeStart 内部吞掉所有异常（仅日志），fire-and-forget 不阻塞响应。
      if (runFinished && profile?.id === "director" && createdProjectIds.length > 0) {
        void this.deps.autoPipeline?.maybeStart({
          profileId: profile.id,
          projectIds: createdProjectIds,
          userId,
          workspaceId: session.workspaceId,
          sessionId,
          modelConfig,
          story: message,
        });
      }
    }
  }
}
