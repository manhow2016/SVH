import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { FolderOpenOutlined, MessageOutlined, PlusOutlined } from "@ant-design/icons";
import { workspaceApi } from "../api/workspace";
import { sessionApi } from "../api/session";
import { useWorkspaceStore } from "../stores/workspace-store";
import { useSessionStore } from "../stores/session-store";
import { useUIStore } from "../stores/ui-store";
import { AgentChat } from "../features/chat/AgentChat";
import { WorkbenchLayout } from "../layouts/WorkbenchLayout";

/**
 * 主页面（文档 §32）：单一页面，Workspace 通过状态管理切换。
 */
export function WorkbenchPage() {
  const { data: workspaces, isLoading } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaceApi.list(),
  });
  const { currentWorkspaceId, setCurrentWorkspaceId, selectedFilePath } = useWorkspaceStore();
  const { currentSessionId, setCurrentSessionId } = useSessionStore();

  // 默认选中第一个 Workspace
  useEffect(() => {
    if (!currentWorkspaceId && workspaces && workspaces.length > 0) {
      setCurrentWorkspaceId(workspaces[0]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, currentWorkspaceId]);

  const { data: sessions } = useQuery({
    queryKey: ["sessions", currentWorkspaceId],
    queryFn: () => sessionApi.list(currentWorkspaceId!),
    enabled: !!currentWorkspaceId,
  });

  // 默认选中第一个 Session（不打断用户手选）
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

  if (isLoading) {
    return (
      <div
        style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <span style={{ color: "var(--color-text-tertiary)", fontSize: 13 }}>加载中…</span>
      </div>
    );
  }

  // 空状态：无 Workspace
  if (!workspaces || workspaces.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          color: "var(--color-text-secondary)",
        }}
      >
        <FolderOpenOutlined style={{ fontSize: 34, color: "var(--color-text-tertiary)" }} />
        <div style={{ fontSize: 15, fontWeight: 600 }}>创建你的第一个工作区</div>
        <div
          style={{
            fontSize: 12,
            color: "var(--color-text-tertiary)",
            maxWidth: 320,
            textAlign: "center",
          }}
        >
          每个工作区对应一个项目目录，包含 svh.project.json、VIDEO_AGENTS.md 与项目文件
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => useUIStore.getState().triggerCreateWorkspace()}
          style={{ marginTop: 6 }}
        >
          新建工作区
        </Button>
        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
          每个工作区对应一个项目目录，可随时在顶部继续创建
        </div>
      </div>
    );
  }

  return (
    <WorkbenchLayout
      center={
        currentSession ? (
          <AgentChat session={currentSession} />
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--color-text-tertiary)",
            }}
          >
            <MessageOutlined style={{ fontSize: 30 }} />
            <div style={{ fontSize: 14, fontWeight: 600 }}>选择一个会话</div>
            <div style={{ fontSize: 12, maxWidth: 340, textAlign: "center" }}>
              在左侧选择或新建会话，向 Agent 描述任务。
              {selectedFilePath ? "" : " Agent 修改的文件会出现在右侧。"}
            </div>
          </div>
        )
      }
    />
  );
}
