import type { ReactNode } from "react";

/** 用户消息（右侧浅蓝气泡，参考 Harness 扁平风格） */
export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div
        style={{
          maxWidth: "78%",
          background: "#eef4ff",
          borderRadius: 6,
          padding: "8px 12px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--color-text-primary)",
        }}
      >
        {content}
      </div>
    </div>
  );
}

/** 助手消息（左侧纯文本） */
export function AssistantMessage({ content }: { content: string }) {
  return (
    <div
      style={{
        maxWidth: "92%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "var(--color-text-primary)",
        lineHeight: 1.7,
      }}
    >
      {content}
    </div>
  );
}

/** 通用消息容器（带行距） */
export function MessageRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {children}
    </div>
  );
}
