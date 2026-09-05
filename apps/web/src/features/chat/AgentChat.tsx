import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "antd";
import { MessageOutlined } from "@ant-design/icons";
import type { Session } from "@svh/shared";
import { sessionApi } from "../../api/session";
import { settingsApi } from "../../api/settings";
import { skillsApi } from "../../api/skills";
import { workspaceApi } from "../../api/workspace";
import { useAgentRun } from "../../hooks/useAgentRun";
import type { SkillDefinitionView } from "../../types/api-types";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

/**
 * Agent Chat（参考 DeepSeek Harness 对话区）：顶部会话标题 + 扁平消息流 + 底部输入框。
 * （「我的资产」入口位于页面顶部导航栏）
 */
export function AgentChat({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const { data: messages, isLoading } = useQuery({
    queryKey: ["messages", session.id],
    queryFn: () => sessionApi.messages(session.id),
    staleTime: 0,
  });
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  });
  // 工作区名（标题展示：工作区名 - 会话名）
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaceApi.list(),
  });
  const workspaceName = workspaces?.find((w) => w.id === session.workspaceId)?.name;

  // 技能列表与本会话的选中技能（null = 普通对话模式）
  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: () => skillsApi.list(),
  });
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const selectedSkill: SkillDefinitionView | null =
    skills?.find((s) => s.id === selectedSkillId) ?? null;

  const { streamItems, isRunning, error, send, runSkill, stop } = useAgentRun(session.id);
  const allModels = (settings?.providers ?? []).flatMap((p) =>
    p.models.map((m) => ({ ...m, providerName: p.name })),
  );
  const enabledIds = settings?.enabledModels ?? null;
  const userEnabled = (m: { id: string }) => enabledIds == null || enabledIds.includes(m.id);
  // 技能未选：仅文本模型；选中技能：技能允许类型 ∩ 用户启用
  const allowedTypes = selectedSkill?.modelTypes ?? ["text"];
  const modelOptions = allModels
    .filter((m) => allowedTypes.includes(m.type) && userEnabled(m))
    .map((m) => ({ label: m.displayName, value: m.modelName }));
  const currentModelName = session.modelId?.trim() || modelOptions[0]?.value;
  const modelDisplayName =
    allModels.find((m) => m.modelName === currentModelName)?.displayName ?? currentModelName;
  const headline = workspaceName ? `${workspaceName} - ${session.title}` : session.title;

  // 模型切换：持久化到会话，并刷新 currentSession（键 ["session", id]）与侧栏列表（键 ["sessions"]）
  const handleModelChange = (modelName: string) => {
    void sessionApi.update(session.id, { modelId: modelName }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["session", session.id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    });
  };
  const handleSkillChange = (skillId: string | null) => setSelectedSkillId(skillId);
  // 技能发送：ChatInput 已组装完整 params（含主参数），模型名取当前选中项
  const handleRunSkill = (params: Record<string, unknown>) => {
    if (!selectedSkill) return;
    void runSkill(selectedSkill, params, currentModelName);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* 顶部：当前会话名 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 36,
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <MessageOutlined style={{ fontSize: 12, color: "var(--color-text-tertiary)" }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {headline}
        </span>
      </div>

      {error && (
        <div style={{ padding: "10px 16px 0" }}>
          <Alert
            type="error"
            showIcon
            message="运行失败"
            description={error}
            style={{ fontSize: 12, borderRadius: 6 }}
          />
        </div>
      )}

      <MessageList messages={messages ?? []} streamItems={streamItems} isLoading={isLoading} />

      <ChatInput
        disabled={!session.id}
        isRunning={isRunning}
        model={modelDisplayName}
        skills={skills ?? []}
        selectedSkill={selectedSkill}
        selectedModel={currentModelName}
        modelOptions={modelOptions}
        onSend={(message) => void send(message)}
        onRunSkill={handleRunSkill}
        onStop={stop}
        onSkillChange={handleSkillChange}
        onModelChange={handleModelChange}
      />
    </div>
  );
}
