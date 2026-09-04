import { useState } from "react";
import type { ReactNode } from "react";
import { Collapse, Skeleton } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DownOutlined,
  LoadingOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { formatJson } from "../../lib/format";

export type ToolCallStatus = "running" | "done" | "error";

export interface ToolCallCardProps {
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
  output?: unknown;
}

const STATUS_META: Record<ToolCallStatus, { label: string; color: string; icon: ReactNode }> = {
  running: { label: "执行中", color: "var(--color-warning)", icon: <LoadingOutlined spin /> },
  done: { label: "已完成", color: "var(--color-success)", icon: <CheckCircleFilled /> },
  error: { label: "失败", color: "var(--color-error)", icon: <CloseCircleFilled /> },
};

/**
 * Tool Call 可视化（文档 §37）。
 *
 * 默认折叠，点击展开 Input / Output；
 * 摘录第一行内容作为概要。
 */
export function ToolCallCard({ toolName, input, status, output }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[status];
  const inputText = summarizeInput(input);
  const borderColor = meta.color;

  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderLeft: `3px solid ${borderColor}`,
        borderRadius: 6,
        background: "var(--color-surface)",
        overflow: "hidden",
        maxWidth: "92%",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 10px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "var(--color-text-primary)",
          fontSize: 13,
          textAlign: "left",
        }}
      >
        <ToolOutlined style={{ color: "var(--color-text-secondary)" }} />
        <code
          style={{
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: 12.5,
            color: "var(--color-primary)",
          }}
        >
          {toolName}
        </code>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--color-text-tertiary)",
            fontSize: 12,
          }}
        >
          {inputText}
        </span>
        <span
          style={{
            color: meta.color,
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {meta.icon}
          {meta.label}
        </span>
        <DownOutlined
          style={{
            fontSize: 10,
            color: "var(--color-text-tertiary)",
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform .15s ease",
          }}
        />
      </button>

      {open && (
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: "input",
              label: "Input",
              children: <PreBlock text={formatJson(input)} />,
            },
            ...(status === "running"
              ? []
              : [
                  {
                    key: "output",
                    label: "Output",
                    children: <PreBlock text={formatJson(output)} />,
                  },
                ]),
          ]}
        />
      )}
    </div>
  );
}

function PreBlock({ text }: { text: string }) {
  return (
    <pre
      style={{
        margin: 4,
        padding: "8px 10px",
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        overflow: "auto",
        maxHeight: 260,
        fontSize: 12,
        lineHeight: 1.55,
        color: "var(--color-text-secondary)",
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {text}
    </pre>
  );
}

/** 工具输入概要：取第一个字符串参数或 JSON 首行 */
function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input.slice(0, 80);
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const path = obj.path;
    if (typeof path === "string") return path;
    const entries = Object.entries(obj);
    const first = entries[0];
    if (first) return `${first[0]}: ${String(first[1]).slice(0, 60)}`;
  }
  const text = String(input);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 骨架屏：运行中消息占位 */
export function ToolCallSkeleton() {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        padding: "8px 12px",
        maxWidth: "92%",
        background: "var(--color-surface)",
      }}
    >
      <Skeleton.Input active size="small" style={{ width: 140 }} />
    </div>
  );
}
