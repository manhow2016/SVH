import { useQuery } from "@tanstack/react-query";
import { Alert } from "antd";
import type { Session } from "@svh/shared";
import { sessionApi } from "../../api/session";
import { useAgentRun } from "../../hooks/useAgentRun";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

/**
 * Agent Chat（文档 §36）：消息流 + 工具调用可视化 + 输入框。
 */
export function AgentChat({ session }: { session: Session }) {
  const { data: messages, isLoading } = useQuery({
    queryKey: ["messages", session.id],
    queryFn: () => sessionApi.messages(session.id),
    staleTime: 0,
  });

  const { streamItems, isRunning, error, send, stop } = useAgentRun(session.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      {/* 会话上下文条 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 36,
          padding: "0 14px",
          borderBottom: "1px solid var(--color-border)",
          fontSize: 12.5,
          flexShrink: 0,
        }}
      >
        <span style={{ color: "var(--color-text-tertiary)" }}>Session</span>
        <span style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{session.title}</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: isRunning
              ? "var(--color-warning)"
              : session.status === "error"
                ? "var(--color-error)"
                : "var(--color-success)",
          }}
        />
        <span style={{ color: "var(--color-text-tertiary)", fontSize: 12 }}>
          {isRunning ? "运行中" : session.status === "error" ? "异常" : "空闲"}
        </span>
      </div>

      {error && (
        <div style={{ padding: "8px 14px 0" }}>
          <Alert
            type="error"
            showIcon
            message="运行失败"
            description={error}
            style={{ fontSize: 12, borderRadius: 6 }}
          />
        </div>
      )}

      <MessageList messages={messages ?? []} streamItems={streamItems} isLoading={isLoading} />

      <ChatInput
        disabled={!session.id}
        isRunning={isRunning}
        onSend={(message) => void send(message)}
        onStop={stop}
      />
    </div>
  );
}
