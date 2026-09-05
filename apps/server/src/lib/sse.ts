import type { ServerResponse } from "node:http";
import type { AgentEvent } from "@svh/core";

/** 向 SSE 连接写入一个 Agent 事件（连接已结束/已销毁时直接跳过） */
export function writeSSE(raw: ServerResponse, event: AgentEvent): void {
  if (raw.writableEnded || raw.destroyed) return;
  raw.write(`event: ${event.type}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 判断工具输出是否为错误（对象且带字符串 error 字段） */
export function isErrorOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "error" in output &&
    typeof (output as { error: unknown }).error === "string"
  );
}
