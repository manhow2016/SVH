import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AutoComplete, Tooltip, message as antdMessage } from "antd";
import { settingsApi } from "../../api/settings";
import { sessionApi } from "../../api/session";
import { useSessionStore } from "../../stores/session-store";
import { ApiError } from "../../api/client";

/**
 * 顶部标签栏（参考 DeepSeek Harness）：
 * 左：SVH 标识；右：模型选择 + 连接状态（设置入口在左侧边栏底部）。
 */
export function WorkbenchHeader() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
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
        gap: 8,
        height: 40,
        padding: "0 10px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        flexShrink: 0,
      }}
    >
      {/* 左侧：SVH 标识（当前会话名显示在左侧边栏顶部） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontWeight: 700,
            fontSize: 13,
            color: "var(--color-primary)",
            letterSpacing: 0.5,
          }}
        >
          SVH
        </span>
      </div>

      <div style={{ flex: 1 }} />

      {/* 模型选择 */}
      <AutoComplete
        size="small"
        value={modelValue}
        style={{ width: 180 }}
        options={uniqueModels(settings?.llm.model, currentSession?.modelId).map((m) => ({
          value: m,
          label: m,
        }))}
        onChange={updateModel}
        placeholder="模型（如 deepseek-chat）"
        variant="borderless"
      />

      {/* 连接状态 */}
      <Tooltip title={connected ? "Server 已连接" : "Server 连接失败"}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: connected ? "var(--color-success)" : "var(--color-error)",
            display: "inline-flex",
            flexShrink: 0,
          }}
        />
      </Tooltip>
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
