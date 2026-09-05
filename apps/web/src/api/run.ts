import { apiUrl, getAuthToken } from "./client";
import type { AgentEvent } from "../types/api-types";

export interface RunAgentOptions {
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * 通用 POST + SSE 解析（供 Agent run / 技能 run 复用）。
 *
 * EventSource 仅支持 GET，因此使用 fetch + ReadableStream 手动解析 SSE 行；
 * SSE 请求同样携带 Bearer Token（与全局认证一致），并在内部统一拼接 API 基础地址。
 */
export async function ssePost(
  url: string,
  body: Record<string, unknown>,
  options: RunAgentOptions,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(apiUrl(url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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

/** 发起 Agent Run（POST + SSE 流解析） */
export async function runAgent(
  sessionId: string,
  message: string,
  options: RunAgentOptions,
): Promise<void> {
  await ssePost(`/api/sessions/${sessionId}/run`, { message }, options);
}
