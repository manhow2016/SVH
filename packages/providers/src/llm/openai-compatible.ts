import type { ChatRequest, LLMEvent, LLMProvider, ToolDefinition } from "./provider";

export interface OpenAICompatibleOptions {
  /** 例如 https://api.openai.com/v1 或 http://localhost:11434/v1 */
  baseUrl: string;
  /** 可为空（本地模型无需鉴权） */
  apiKey?: string;
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

/**
 * OpenAI Compatible Provider（文档 §11.3）。
 *
 * 支持 OpenAI / DeepSeek / 自定义兼容端点，纯 fetch + SSE 解析。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OpenAICompatibleOptions) {
    const base = options.baseUrl.trim().replace(/\/+$/, "");
    if (base === "") {
      throw new Error("baseUrl is required");
    }
    this.baseUrl = base;
    this.apiKey = options.apiKey?.trim() || undefined;
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<LLMEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      // 转换为 OpenAI wire 格式（toolCallId → tool_call_id，toolCalls → tool_calls）
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls } : {}),
      })),
      stream: true,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) return;
      yield { type: "error", error: `LLM request failed: ${(err as Error).message}` };
      return;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      yield {
        type: "error",
        error: `LLM request failed (${response.status}${detail ? `: ${truncate(detail, 500)}` : ""})`,
      };
      return;
    }
    if (!response.body) {
      yield { type: "error", error: "LLM response has no body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 按 index 累积工具调用片段（OpenAI 流式 tool_calls 分片到达）
    const toolCallAcc = new Map<
      number,
      { id: string; name: string; argsAcc: string }
    >();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line === "" || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            yield* emitToolCalls(toolCallAcc);
            yield { type: "done" };
            return;
          }
          let json: OpenAIChatCompletionResponse;
          try {
            json = JSON.parse(data);
          } catch {
            continue; // 忽略无法解析的分片
          }
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            yield { type: "delta", content: delta.content };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const acc = toolCallAcc.get(tc.index) ?? { id: tc.id ?? "", name: "", argsAcc: "" };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.argsAcc += tc.function.arguments;
              toolCallAcc.set(tc.index, acc);
            }
          }
        }
      }
      // 流结束（无 [DONE]）时兜底发出剩余工具调用
      yield* emitToolCalls(toolCallAcc);
      yield { type: "done" };
    } catch (err) {
      if (isAbortError(err)) return;
      yield { type: "error", error: `LLM stream error: ${(err as Error).message}` };
    }
  }
}

/** 将累积的工具调用按序发出 */
function* emitToolCalls(
  acc: Map<number, { id: string; name: string; argsAcc: string }>,
): Generator<LLMEvent> {
  const indexes = [...acc.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const item = acc.get(index);
    if (!item) continue;
    yield {
      type: "tool_call",
      toolCall: {
        id: item.id || `call_${index}`,
        name: item.name,
        arguments: item.argsAcc,
      },
    };
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 便捷工厂：仅当未注册时避免重复创建由调用方控制 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(options);
}
