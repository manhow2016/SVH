import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "antd";
import { MessageOutlined } from "@ant-design/icons";
import type { Session } from "@svh/shared";
import { agentApi } from "../../api/agent";
import { sessionApi } from "../../api/session";
import { skillsApi } from "../../api/skills";
import { useAgentRun } from "../../hooks/useAgentRun";
import type { SkillDefinitionView } from "../../types/api-types";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

/**
 * Agent Chat（参考 DeepSeek Harness 对话区）：顶部会话标题 + 扁平消息流 + 底部输入框。
 * （「我的资产」入口位于页面顶部导航栏）
 */
export function AgentChat({ session }: { session: Session }) {
  const { data: messages, isLoading } = useQuery({
    queryKey: ["messages", session.id],
    queryFn: () => sessionApi.messages(session.id),
    staleTime: 0,
  });
  // 技能列表与本会话的选中技能（null = 普通对话模式；模型由系统决定）
  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: () => skillsApi.list(),
  });
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const selectedSkill: SkillDefinitionView | null =
    skills?.find((s) => s.id === selectedSkillId) ?? null;

  // Agent 角色列表与选中角色（null = 通用助手；Director 建项后自动串联生产工作流）
  const { data: profiles } = useQuery({
    queryKey: ["agent-profiles"],
    queryFn: () => agentApi.profiles(),
  });
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  const { streamItems, isRunning, error, send, runSkill, stop } = useAgentRun(session.id);
  const headline = session.title;

  // 技能发送：ChatInput 已组装完整 params（含主参数），模型由系统按技能类型自动选择
  const handleRunSkill = (params: Record<string, unknown>) => {
    if (!selectedSkill) return;
    void runSkill(selectedSkill, params);
  };
  const handleSkillChange = (skillId: string | null) => setSelectedSkillId(skillId);

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
        skills={skills ?? []}
        selectedSkill={selectedSkill}
        profiles={profiles ?? []}
        selectedProfile={selectedProfileId}
        onSend={(message) => void send(message, selectedProfileId ?? undefined)}
        onRunSkill={handleRunSkill}
        onStop={stop}
        onSkillChange={handleSkillChange}
        onProfileChange={setSelectedProfileId}
      />
    </div>
  );
}
