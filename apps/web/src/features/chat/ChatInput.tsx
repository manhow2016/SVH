import { useState } from "react";
import { Button, Input } from "antd";
import { SendOutlined, StopOutlined } from "@ant-design/icons";

export interface ChatInputProps {
  disabled?: boolean;
  isRunning: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
}

/**
 * 消息输入（文档 §38）。
 * - Enter 发送
 * - Shift + Enter 换行
 * - 运行期间 Send → Stop（AbortController 终止当前 LLM 请求）
 */
export function ChatInput({ disabled, isRunning, onSend, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
        padding: "10px 14px 12px",
        background: "var(--color-surface)",
        flexShrink: 0, // 输入框不挤压消息区、不撑破面板
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          background: "var(--color-bg)",
          padding: "6px 8px 6px 12px",
          transition: "border-color .15s",
        }}
      >
        <Input.TextArea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled ? "请先选择或创建一个 Session" : "输入消息…（Enter 发送，Shift+Enter 换行）"
          }
          autoSize={{ minRows: 1, maxRows: 8 }}
          variant="borderless"
          disabled={disabled}
          style={{ padding: 0, background: "transparent", resize: "none" }}
        />
        {isRunning ? (
          <Button danger icon={<StopOutlined />} onClick={onStop} size="small" className="shrink-0">
            停止
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={send}
            disabled={disabled || value.trim() === ""}
            size="small"
            className="shrink-0"
          >
            发送
          </Button>
        )}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: "var(--color-text-tertiary)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>Enter 发送 · Shift+Enter 换行</span>
        <span>SVH Agent Harness</span>
      </div>
    </div>
  );
}
