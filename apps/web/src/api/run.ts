import type { AgentEvent } from "../types/api-types";

export interface RunAgentOptions {
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * 发起 Agent Run（POST + SSE 流解析）。
 *
 * EventSource 仅支持 GET，因此使用 fetch + ReadableStream 手动解析 SSE 行。
 */
export async function runAgent(
  sessionId: string,
  message: string,
  options: RunAgentOptions,
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal: options.signal,
  });

  if (!response.ok) {
    let messageText = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      messageText = body.error?.message ?? messageText;
    } catch {
      // ignore
    }
    throw new Error(messageText);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length === 0) continue;
      try {
        const data = JSON.parse(dataLines.join("\n")) as AgentEvent | { type?: string };
        // 以事件名称为准（data 中也包含 type，两者一致）
        if (data && typeof data.type === "string") {
          options.onEvent(data as AgentEvent);
        }
      } catch {
        // 忽略无法解析的行
      }
      void eventName;
    }
  }
}
