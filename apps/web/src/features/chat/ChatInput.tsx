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
 * 圆角卡片输入区（限宽居中）+ 右侧圆形发送按钮 + 底部信息行（模型 / 快捷提示）。
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
        padding: "8px 16px 12px",
        flexShrink: 0,
      }}
    >
      {/* 卡片：输入行 + 底部信息行 整体 */}
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          border: "1px solid var(--color-border)",
          borderRadius: 12,
          background: "var(--color-surface)",
          boxShadow: "0 2px 8px rgba(0,0,0,.06)",
        }}
      >
        {/* 输入行 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            padding: "12px 8px 6px 14px",
          }}
        >
          <Input.TextArea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              disabled ? "请先选择或创建一个会话" : "发送消息或提问 · Enter 发送，Shift+Enter 换行"
            }
            autoSize={{ minRows: 3, maxRows: 12 }}
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
                width: 32,
                height: 32,
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
                width: 32,
                height: 32,
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

        {/* 底部信息行（卡片内部） */}
        <div
          style={{
            padding: "0 14px 10px",
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
    </div>
  );
}
