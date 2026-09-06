import type { ChatMessage, ToolDefinition } from "@svh/providers";
import type { LLMProvider, ModelConfig } from "@svh/providers";
import type { ProviderRegistry } from "@svh/providers";
import type { ToolRegistry } from "@svh/tools";
import type { WorkspaceManager } from "@svh/workspace";
import type { ContextBuilder } from "../context/context-builder";
import type { AgentEvent } from "../events/agent-events";
import { runAgentLoop, MAX_TOOL_ITERATIONS } from "./agent-loop";
import type { AgentRunInput } from "./agent-types";

export interface AgentRuntimeOptions {
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  contextBuilder: ContextBuilder;
  workspaceManager: WorkspaceManager;
  maxToolIterations?: number;
}

/**
 * Agent Runtime（文档 §7）。
 *
 * 职责：组装 Context → Provider Registry → 循环调用 LLM → 执行 Tool → 输出事件流。
 * 不持久化、不依赖 Server；事件通过 AsyncIterable<AgentEvent> 输出。
 */
export class AgentRuntime {
  private readonly options: AgentRuntimeOptions;

  constructor(options: AgentRuntimeOptions) {
    this.options = options;
  }

  async *run(input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "run.started" };
    try {
      const provider = this.resolveProvider(input.modelConfig);
      const built = await this.options.contextBuilder.build(input);
      const ws = await this.options.workspaceManager.get(input.workspaceId);

      yield* runAgentLoop({
        request: {
          model: input.modelConfig.model,
          messages: built.messages,
          tools: toToolDefinitions(filterToolsForProfile(this.options.toolRegistry.list(), input.profile?.allowedTools)),
          temperature: input.modelConfig.temperature,
          maxTokens: input.modelConfig.maxTokens,
        },
        provider,
        tools: this.options.toolRegistry,
        toolContext: {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          workspaceRoot: ws.rootPath,
        },
        maxToolIterations: this.options.maxToolIterations ?? MAX_TOOL_ITERATIONS,
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: "run.error", error: "Run aborted" };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "run.error", error: message };
    }
  }

  private resolveProvider(config: ModelConfig): LLMProvider {
    return this.options.providerRegistry.get(config.providerId);
  }
}

/** 将 Tool Registry 中的工具转换为模型可识别的 ToolDefinition */
export function toToolDefinitions(tools: ReturnType<ToolRegistry["list"]>): ToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));
}

/**
 * 按 Agent Profile 的工具白名单过滤（文档 §8）。
 * 未配置白名单（undefined/空数组）时返回全部工具。
 */
export function filterToolsForProfile(
  tools: ReturnType<ToolRegistry["list"]>,
  allowedTools?: string[],
): ReturnType<ToolRegistry["list"]> {
  if (!allowedTools || allowedTools.length === 0) {
    return tools;
  }
  return tools.filter((tool) => allowedTools.includes(tool.name));
}

/** 供调用方校验 ChatMessage 的工具格式（保留导出以便复用） */
export type { ChatMessage };

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}
