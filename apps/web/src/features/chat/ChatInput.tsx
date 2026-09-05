import { useEffect, useState } from "react";
import { Input, InputNumber, Select } from "antd";
import { SendOutlined, StopOutlined } from "@ant-design/icons";
import type { SkillDefinitionView } from "../../types/api-types";

export interface ChatInputProps {
  disabled?: boolean;
  isRunning: boolean;
  /** 当前生效模型名（无技能时展示 / 模型 Select 值） */
  model?: string;
  /** 可选技能列表 */
  skills?: SkillDefinitionView[];
  /** 当前选中技能（null = 普通对话） */
  selectedSkill?: SkillDefinitionView | null;
  /** 当前模型名（会话 modelId） */
  selectedModel?: string;
  /** 可选模型（已按技能类型 + 用户启用过滤，由父组件计算） */
  modelOptions?: Array<{ label: string; value: string }>;
  /** 普通对话发送（输入框文本即消息） */
  onSend: (message: string) => void;
  /** 技能发送（主参数已并入 params[primary.key]，其余参数由本组件收集） */
  onRunSkill?: (params: Record<string, unknown>) => void;
  onStop: () => void;
  onSkillChange?: (skillId: string | null) => void;
  onModelChange?: (modelName: string) => void;
}

/**
 * 消息输入（参考 DeepSeek Harness）：
 * 圆角卡片输入区（限宽居中）+ 右侧圆形发送按钮 + 底部信息行（技能 / 模型 / 快捷提示）。
 * - 选中技能时展示内联参数控件行（非主参数），主参数 = 输入框文本；
 * - Enter 发送；Shift + Enter 换行；运行期间 Send → Stop。
 */
export function ChatInput({
  disabled,
  isRunning,
  skills,
  selectedSkill,
  selectedModel,
  modelOptions,
  onSend,
  onRunSkill,
  onStop,
  onSkillChange,
  onModelChange,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  // 其余参数值（非 primary），技能切换时按 default 重置
  const [paramValues, setParamValues] = useState<Record<string, string | number | undefined>>({});
  const otherParams = selectedSkill?.params.filter((p) => !p.primary) ?? [];

  // 技能切换时按参数 default 初始化内联参数值（无 default 的保持空）
  useEffect(() => {
    const next: Record<string, string | number | undefined> = {};
    for (const p of otherParams) {
      if (p.default !== undefined) next[p.key] = p.default;
    }
    setParamValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSkill?.id]);

  // 更新单个参数值（保持其它参数不变）
  const setParamValue = (key: string, v: string | number | undefined) => {
    setParamValues((prev) => ({ ...prev, [key]: v }));
  };

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    if (selectedSkill) {
      // 技能模式：主参数 = 输入框文本，其余参数来自内联控件
      const primary = selectedSkill.params.find((p) => p.primary);
      const params: Record<string, unknown> = { ...paramValues };
      if (primary) params[primary.key] = text;
      onRunSkill?.(params);
    } else {
      onSend(text);
    }
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
      {/* 卡片：参数行(可选) + 输入行 + 底部信息行 整体 */}
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
        {/* 内联参数控件行（技能选中且存在非主参数时显示） */}
        {selectedSkill && otherParams.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px 0",
              flexWrap: "wrap",
            }}
          >
            {otherParams.map((p) => (
              <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{p.label}</span>
                {p.type === "number" ? (
                  <InputNumber
                    size="small"
                    min={1}
                    max={99}
                    value={paramValues[p.key] as number}
                    onChange={(v) => setParamValue(p.key, v !== null ? v : undefined)}
                  />
                ) : p.type === "select" ? (
                  <Select
                    size="small"
                    style={{ minWidth: 110 }}
                    value={paramValues[p.key]}
                    options={p.options}
                    onChange={(v) => setParamValue(p.key, v)}
                  />
                ) : (
                  <Input
                    size="small"
                    style={{ width: 170 }}
                    value={paramValues[p.key] as string | undefined}
                    placeholder={p.placeholder}
                    onChange={(e) => setParamValue(p.key, e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

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
              disabled
                ? "请先选择或创建一个会话"
                : selectedSkill
                  ? (selectedSkill.params.find((p) => p.primary)?.placeholder ?? "输入技能参数…")
                  : "发送消息或提问 · Enter 发送，Shift+Enter 换行"
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

        {/* 底部信息行（卡片内部）：技能 + 模型 + 快捷提示 */}
        <div
          style={{
            padding: "0 14px 10px",
            fontSize: 11,
            color: "var(--color-text-tertiary)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Select
            size="small"
            variant="borderless"
            style={{ minWidth: 96, fontSize: 11 }}
            placeholder="技能"
            allowClear
            value={selectedSkill?.id ?? undefined}
            options={(skills ?? []).map((s) => ({ label: s.name, value: s.id }))}
            onChange={(v: string | undefined) => onSkillChange?.(v ?? null)}
            popupMatchSelectWidth={false}
          />
          <Select
            size="small"
            variant="borderless"
            style={{ minWidth: 120, fontSize: 11 }}
            placeholder="模型"
            value={selectedModel}
            options={modelOptions}
            onChange={(v: string) => onModelChange?.(v)}
            popupMatchSelectWidth={false}
          />
          <span style={{ flex: 1, textAlign: "right" }}>Enter 发送 · Shift+Enter 换行</span>
        </div>
      </div>
    </div>
  );
}
