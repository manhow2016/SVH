import { useState } from "react";
import { Input } from "antd";
import { SendOutlined, StopOutlined } from "@ant-design/icons";

export interface ChatInputProps {
  disabled?: boolean;
  isRunning: boolean;
  /** 当前生效的模型名（底部信息行展示） */
  model?: string;
  onSend: (message: string) => void;
  onStop: () => void;
}

/**
 * 消息输入（参考 DeepSeek Harness）：
 * 圆角边框输入行 + 右侧圆形发送按钮 + 底部信息行（模型 / 快捷提示）。
 * - Enter 发送；Shift + Enter 换行；运行期间 Send → Stop。
 */
export function ChatInput({ disabled, isRunning, model, onSend, onStop }: ChatInputProps) {
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
        padding: "10px 16px 12px",
        background: "var(--color-surface)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 6,
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          background: "var(--color-surface)",
          padding: "6px 6px 6px 12px",
          transition: "border-color .15s",
        }}
      >
        <Input.TextArea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled ? "请先选择或创建一个会话" : "发送消息或提问 · Enter 发送，Shift+Enter 换行"
          }
          autoSize={{ minRows: 1, maxRows: 8 }}
          variant="borderless"
          disabled={disabled}
          style={{ padding: 0, background: "transparent", resize: "none" }}
        />
        {isRunning ? (
          <button
            type="button"
            onClick={onStop}
            title="停止"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "none",
              background: "var(--color-error)",
              color: "#fff",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <StopOutlined style={{ fontSize: 13 }} />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={disabled || value.trim() === ""}
            title="发送"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "none",
              background:
                disabled || value.trim() === "" ? "var(--color-border)" : "var(--color-primary)",
              color: "#fff",
              cursor: disabled || value.trim() === "" ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <SendOutlined style={{ fontSize: 13 }} />
          </button>
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
        <span>{model ? `模型：${model}` : "未配置模型"}</span>
        <span>Enter 发送 · Shift+Enter 换行</span>
      </div>
    </div>
  );
}
