import { useEffect, useRef } from "react";
import { Skeleton } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import type { SessionMessage } from "@svh/shared";
import type { StreamItem } from "../../hooks/useAgentRun";
import { AssistantMessage, MessageRow, UserMessage } from "./messages";
import { ToolCallCard } from "./ToolCallCard";

export interface MessageListProps {
  messages: SessionMessage[];
  streamItems: StreamItem[];
  isLoading?: boolean;
}

/** 消息列表：持久化消息 + 流式消息叠加渲染 */
export function MessageList({ messages, streamItems, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const lastStreamLen = lastStreamLength(streamItems);
  // 自动滚动到底部（跟随流式输出）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages.length, streamItems.length, lastStreamLen]);

  if (isLoading) {
    return (
      <div style={{ padding: 16 }}>
        <Skeleton active paragraph={{ rows: 4 }} />
      </div>
    );
  }

  if (messages.length === 0 && streamItems.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          color: "var(--color-text-tertiary)",
        }}
      >
        <InboxOutlined style={{ fontSize: 28 }} />
        <div style={{ fontSize: 13 }}>开始新的对话</div>
        <div style={{ fontSize: 12 }}>向 Agent 描述任务，它将读取工作区并调用工具修改文件</div>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "14px 16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {messages.map((message) => renderMessage(message))}
      {streamItems.map((item) => renderStreamItem(item))}
      <div ref={bottomRef} />
    </div>
  );
}

function renderMessage(message: SessionMessage) {
  const meta = message.metadata ?? {};
  if (message.role === "user") {
    return (
      <MessageRow key={message.id}>
        <UserMessage content={message.content} />
      </MessageRow>
    );
  }
  if (message.role === "assistant") {
    if (!message.content && !meta.toolCalls?.length) return null;
    return (
      <MessageRow key={message.id}>
        {message.content ? <AssistantMessage content={message.content} /> : null}
      </MessageRow>
    );
  }
  if (message.role === "tool") {
    return (
      <MessageRow key={message.id}>
        <ToolCallCard
          toolName={meta.toolName ?? "tool"}
          input={meta.input}
          output={meta.output}
          status={meta.error ? "error" : "done"}
        />
      </MessageRow>
    );
  }
  return null;
}

function renderStreamItem(item: StreamItem) {
  if (item.kind === "assistant") {
    return (
      <MessageRow key={item.id}>
        <AssistantMessage content={item.content} />
      </MessageRow>
    );
  }
  return (
    <MessageRow key={item.id}>
      <ToolCallCard
        toolName={item.toolName}
        input={item.input}
        output={item.output}
        status={item.status}
      />
    </MessageRow>
  );
}

function lastStreamLength(items: StreamItem[]): number {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant") return last.content.length;
  return 0;
}
