import { useQuery } from "@tanstack/react-query";
import { Alert } from "antd";
import { MessageOutlined } from "@ant-design/icons";
import type { Session } from "@svh/shared";
import { sessionApi } from "../../api/session";
import { settingsApi } from "../../api/settings";
import { workspaceApi } from "../../api/workspace";
import { useAgentRun } from "../../hooks/useAgentRun";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

/**
 * Agent Chat（参考 DeepSeek Harness 对话区）：顶部会话标题 + 扁平消息流 + 底部输入框。
 */
export function AgentChat({ session }: { session: Session }) {
  const { data: messages, isLoading } = useQuery({
    queryKey: ["messages", session.id],
    queryFn: () => sessionApi.messages(session.id),
    staleTime: 0,
  });
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  });
  // 工作区名（标题展示：工作区名 - 会话名）
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaceApi.list(),
  });
  const workspaceName = workspaces?.find((w) => w.id === session.workspaceId)?.name;

  const { streamItems, isRunning, error, send, stop } = useAgentRun(session.id);
  const model = session.modelId?.trim() || settings?.llm.model || "";
  const headline = workspaceName ? `${workspaceName} - ${session.title}` : session.title;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* 顶部：当前会话名 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 36,
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <MessageOutlined style={{ fontSize: 12, color: "var(--color-text-tertiary)" }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {headline}
        </span>
      </div>

      {error && (
        <div style={{ padding: "10px 16px 0" }}>
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
        model={model}
        onSend={(message) => void send(message)}
        onStop={stop}
      />
    </div>
  );
}
