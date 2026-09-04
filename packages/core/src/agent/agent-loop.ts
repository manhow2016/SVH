import { randomId } from "@svh/shared";
import type { ChatMessage, ChatRequest, LLMProvider } from "@svh/providers";
import type { ToolContext, ToolRegistry } from "@svh/tools";
import type { AgentEvent } from "../events/agent-events";

/** 最大 Tool 迭代次数（文档 §10，防无限循环） */
export const MAX_TOOL_ITERATIONS = 20;

/** Agent Loop 内部错误（由 AgentRuntime 捕获并转为 run.error 事件） */
export class AgentLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLoopError";
  }
}

export interface AgentLoopParams {
  /** 首轮请求（消息列表会被循环内追加 tool 结果） */
  request: ChatRequest;
  provider: LLMProvider;
  tools: ToolRegistry;
  toolContext: ToolContext;
  maxToolIterations?: number;
  signal?: AbortSignal;
}

/**
 * Agent Loop（文档 §9）：User Message → 调用 LLM →
 * 含 Tool Call → 执行 Tool → 回传结果 → 再次调用 LLM → 直到无 Tool Call 或超限。
 */
export async function* runAgentLoop(params: AgentLoopParams): AsyncIterable<AgentEvent> {
  const max = params.maxToolIterations ?? MAX_TOOL_ITERATIONS;
  const messages: ChatMessage[] = [...params.request.messages];

  for (let iteration = 0; iteration < max; iteration++) {
    const messageId = randomId("msg");
    let assistantText = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    // ---- 调用 LLM ----
    yield { type: "message.started", messageId };
    for await (const event of params.provider.chat({ ...params.request, messages }, params.signal)) {
      if (event.type === "delta") {
        assistantText += event.content;
        yield { type: "message.delta", messageId, content: event.content };
      } else if (event.type === "tool_call") {
        toolCalls.push(event.toolCall);
      } else if (event.type === "error") {
        throw new AgentLoopError(event.error);
      }
      // done → 继续
    }
    yield { type: "message.completed", messageId };

    // ---- 无 Tool Call：完成 ----
    if (toolCalls.length === 0) {
      yield { type: "run.completed" };
      return;
    }

    // ---- 有 Tool Call：执行并回传 ----
    messages.push({
      role: "assistant",
      content: assistantText === "" ? null : assistantText,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const tc of toolCalls) {
      const input = safeParseArguments(tc.arguments);
      yield { type: "tool.called", toolCallId: tc.id, toolName: tc.name, input };

      const tool = params.tools.get(tc.name);
      let output: unknown;
      if (!tool) {
        output = { error: `Unknown tool: ${tc.name}` };
      } else {
        try {
          const result = await tool.execute(input, params.toolContext);
          output = result.output;
          // 文件系统被修改 → 通知观察者
          if (result.changedPath) {
            yield { type: "workspace.changed", paths: [result.changedPath] };
          }
        } catch (err) {
          // Tool 执行失败不中断整个 Run，把错误回传给模型
          output = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      yield { type: "tool.completed", toolCallId: tc.id, toolName: tc.name, output };

      // 工具结果回传模型（角色为 tool，关联 toolCallId）
      messages.push({
        role: "tool",
        content: JSON.stringify(output ?? null),
        toolCallId: tc.id,
      });
    }
    // 继续下一轮循环（连续 Tool Call）
  }

  // 超过最大迭代次数（文档 §10）
  throw new AgentLoopError("Maximum tool iterations exceeded");
}

function safeParseArguments(args: string): unknown {
  if (!args || args.trim() === "") return {};
  try {
    return JSON.parse(args);
  } catch {
    // 模型偶尔输出非 JSON，兜底为字符串文本
    return { _raw: args };
  }
}
