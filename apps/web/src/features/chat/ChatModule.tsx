import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Select, message as antdMessage } from "antd";
import { MessageOutlined, PlusOutlined } from "@ant-design/icons";
import { sessionApi } from "../../api/session";
import { useSessionStore } from "../../stores/session-store";
import { AgentChat } from "./AgentChat";

/**
 * 会话模块（制作中心内容区「会话」页签）：
 * 顶部 会话选择 + 新建会话；主体为对话（输入框 + 消息流）。
 * 会话自动归属用户默认工作区（后端解析，前端零工作区概念）。
 */
export function ChatModule() {
  const queryClient = useQueryClient();
  const { currentSessionId, setCurrentSessionId } = useSessionStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("新会话");

  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessionApi.list(),
  });

  // 默认选中第一个会话（不打断手选）
  useEffect(() => {
    if (!currentSessionId && sessions && sessions.length > 0) {
      setCurrentSessionId(sessions[0]!.id);
    }
  }, [sessions, currentSessionId, setCurrentSessionId]);

  const { data: currentSession } = useQuery({
    queryKey: ["session", currentSessionId],
    queryFn: () => sessionApi.get(currentSessionId!),
    enabled: !!currentSessionId,
  });

  const createMutation = useMutation({
    mutationFn: () => sessionApi.create(name.trim()),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setCreating(false);
      setName("新会话");
      setCurrentSessionId(session.id);
      antdMessage.success("已新建会话");
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 顶部工具条：会话选择 + 新建 */}
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <MessageOutlined style={{ color: "var(--color-primary)", fontSize: 14 }} />
        <Select
          size="small"
          style={{ width: 240 }}
          placeholder="选择一个会话"
          value={currentSessionId}
          onChange={setCurrentSessionId}
          notFoundContent="暂无会话，点击右侧新建"
          options={(sessions ?? []).map((s) => ({ value: s.id, label: s.title }))}
        />
        <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          新建会话
        </Button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          向 Agent 描述任务，即可自动操作制作中心数据
        </span>
      </div>

      {/* 对话主体 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {currentSession ? (
          <AgentChat session={currentSession} />
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: "var(--color-text-tertiary)",
            }}
          >
            <MessageOutlined style={{ fontSize: 32 }} />
            <div style={{ fontSize: 14, fontWeight: 600 }}>选择一个会话</div>
            <div style={{ fontSize: 12, maxWidth: 340, textAlign: "center" }}>
              在上方选择或新建会话，向 Agent 描述任务；Agent 会调用工具创建项目、剧本、分镜与成片。
            </div>
          </div>
        )}
      </div>

      <Modal
        open={creating}
        title="新建会话"
        width={380}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        onOk={() => {
          if (!name.trim()) {
            antdMessage.warning("请输入会话名称");
            return;
          }
          createMutation.mutate();
        }}
        onCancel={() => setCreating(false)}
        destroyOnHidden
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="会话名称，如：脚本创作"
          onPressEnter={() => {
            if (name.trim()) createMutation.mutate();
          }}
          autoFocus
        />
      </Modal>
    </div>
  );
}
