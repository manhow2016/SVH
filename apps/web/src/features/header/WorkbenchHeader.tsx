import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AutoComplete, Button, Input, Modal, Select, Tooltip, message as antdMessage } from "antd";
import { ApiOutlined, PlusOutlined, SlidersOutlined } from "@ant-design/icons";
import { workspaceApi } from "../../api/workspace";
import { settingsApi } from "../../api/settings";
import { sessionApi } from "../../api/session";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useSessionStore } from "../../stores/session-store";
import { useUIStore } from "../../stores/ui-store";
import { ApiError } from "../../api/client";

/**
 * WorkbenchHeader（文档 §34）：
 * SVH Logo + Workspace Selector + Model Selector + Connection Status + Settings。
 * 保持 Developer Tool / IDE / Agent Harness 风格。
 */
export function WorkbenchHeader() {
  const { currentWorkspaceId, setCurrentWorkspaceId } = useWorkspaceStore();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const createWorkspaceSignal = useUIStore((s) => s.createWorkspaceSignal);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  // 监听「新建 Workspace」请求（来自空状态页面等）
  useEffect(() => {
    if (createWorkspaceSignal > 0) setCreating(true);
  }, [createWorkspaceSignal]);

  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaceApi.list(),
  });
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

  const createMutation = useMutation({
    mutationFn: () => workspaceApi.create(newName.trim()),
    onSuccess: (ws) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setCreating(false);
      setNewName("");
      setCurrentWorkspaceId(ws.id);
      antdMessage.success(`已创建 Workspace「${ws.name}」`);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

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

      {/* Workspace Selector */}
      <Select
        value={currentWorkspaceId ?? undefined}
        onChange={(id) => setCurrentWorkspaceId(id)}
        options={(workspaces ?? []).map((w) => ({ value: w.id, label: w.name }))}
        placeholder="选择 Workspace"
        style={{ width: 200 }}
        size="small"
        showSearch
        optionFilterProp="label"
        allowClear={false}
      />
      <Button size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
        新建 Workspace
      </Button>

      <div style={{ width: 1, height: 22, background: "var(--color-border)" }} />

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

      {/* 新建 Workspace Modal */}
      <Modal
        open={creating}
        title="创建 Workspace"
        width={380}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        onOk={() => {
          if (!newName.trim()) {
            antdMessage.warning("请输入名称");
            return;
          }
          createMutation.mutate();
        }}
        onCancel={() => {
          setCreating(false);
          setNewName("");
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="如：东京旅游视频"
            onPressEnter={() => {
              if (newName.trim()) createMutation.mutate();
            }}
            prefix={<ApiOutlined style={{ color: "var(--color-text-tertiary)" }} />}
          />
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-tertiary)" }}>
          创建后自动生成 svh.project.json 与 VIDEO_AGENTS.md
        </div>
      </Modal>
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
