import { useQuery } from "@tanstack/react-query";
import { Alert } from "antd";
import type { Session } from "@svh/shared";
import { sessionApi } from "../../api/session";
import { settingsApi } from "../../api/settings";
import { useAgentRun } from "../../hooks/useAgentRun";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

/**
 * Agent Chat（参考 DeepSeek Harness 对话区）：扁平消息流 + 底部输入框。
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

  const { streamItems, isRunning, error, send, stop } = useAgentRun(session.id);
  const model = session.modelId?.trim() || settings?.llm.model || "";

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
