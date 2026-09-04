import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AutoComplete, Tooltip, message as antdMessage } from "antd";
import { SlidersOutlined } from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import { sessionApi } from "../../api/session";
import { useSessionStore } from "../../stores/session-store";
import { useUIStore } from "../../stores/ui-store";
import { ApiError } from "../../api/client";

/**
 * WorkbenchHeader（文档 §34）：
 * SVH Logo + Model Selector + Connection Status + Settings。
 * Workspace 选择已移至左侧边栏。
 */
export function WorkbenchHeader() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  });
  const { data: currentSession } = useQuery({
    queryKey: ["session", currentSessionId],
    queryFn: () => sessionApi.get(currentSessionId!),
    enabled: !!currentSessionId,
  });
  const connected = !!settings;
  const modelValue = currentSession?.modelId?.trim() || settings?.llm.model || "未配置模型";

  const updateModel = (model: string) => {
    if (!currentSessionId) {
      antdMessage.info("先选择一个会话，模型将绑定到该会话");
      return;
    }
    void sessionApi
      .update(currentSessionId, { modelId: model })
      .then(() => queryClient.invalidateQueries({ queryKey: ["session", currentSessionId] }))
      .catch((err: unknown) =>
        antdMessage.error(err instanceof ApiError ? err.message : "模型更新失败"),
      );
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 44,
        padding: "0 12px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
        <span
          style={{
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontWeight: 700,
            fontSize: 14,
            color: "var(--color-primary)",
            letterSpacing: 1,
          }}
        >
          SVH
        </span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
          Short Video Harness
        </span>
      </div>

      {/* Model Selector */}
      <Tooltip title="当前会话使用的模型（绑定到会话，可自定义输入）">
        <AutoComplete
          size="small"
          value={modelValue}
          style={{ width: 200 }}
          options={uniqueModels(settings?.llm.model, currentSession?.modelId).map((m) => ({
            value: m,
            label: m,
          }))}
          onChange={updateModel}
          placeholder="模型（如 deepseek-chat）"
        />
      </Tooltip>

      <div style={{ flex: 1 }} />

      {/* Connection Status */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: "var(--color-text-secondary)",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: connected ? "var(--color-success)" : "var(--color-error)",
          }}
        />
        {connected ? "已连接" : "连接失败"}
      </span>

      {/* Settings */}
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="模型设置"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          background: "transparent",
          color: "var(--color-text-secondary)",
          cursor: "pointer",
        }}
      >
        <SlidersOutlined />
      </button>
    </div>
  );
}

function uniqueModels(settingsModel?: string, sessionModel?: string): string[] {
  const list: string[] = [];
  for (const m of [settingsModel, sessionModel, "deepseek-chat", "gpt-4o-mini", "qwen2.5:14b"]) {
    if (m && !list.includes(m)) list.push(m);
  }
  return list;
}
