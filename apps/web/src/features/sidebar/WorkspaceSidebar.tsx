import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Modal, Select, message as antdMessage } from "antd";
import {
  AppstoreOutlined,
  CloseCircleFilled,
  DeleteOutlined,
  EditOutlined,
  LoadingOutlined,
  PlusOutlined,
  SlidersOutlined,
} from "@ant-design/icons";
import type { Session } from "@svh/shared";
import { workspaceApi } from "../../api/workspace";
import { sessionApi } from "../../api/session";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useSessionStore } from "../../stores/session-store";
import { useUIStore } from "../../stores/ui-store";
import { formatRelativeTime } from "../../lib/format";
import type { Workspace } from "../../types/api-types";

/**
 * 左侧边栏（参考 DeepSeek Harness）：
 * 顶部「工作区」选择行 → 「新会话」按钮 → 会话列表（标题 + 相对时间 + 状态）
 * → 底部「模型设置」入口。
 */
export function WorkspaceSidebar() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, setCurrentWorkspaceId } = useWorkspaceStore();
  const { currentSessionId, setCurrentSessionId } = useSessionStore();
  const createWorkspaceSignal = useUIStore((s) => s.createWorkspaceSignal);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  // 弹窗状态
  const [creatingWs, setCreatingWs] = useState(false);
  const [wsName, setWsName] = useState("");
  const [deletingWs, setDeletingWs] = useState<Workspace | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionName, setSessionName] = useState("新会话");
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);

  // 空状态页面的「新建 Workspace」触发
  useEffect(() => {
    if (createWorkspaceSignal > 0) {
      setWsName("");
      setCreatingWs(true);
    }
  }, [createWorkspaceSignal]);

  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaceApi.list(),
  });

  const { data: sessions } = useQuery({
    queryKey: ["sessions", currentWorkspaceId],
    queryFn: () => sessionApi.list(currentWorkspaceId!),
    enabled: !!currentWorkspaceId,
  });

  // 当前会话必须属于当前 workspace
  useEffect(() => {
    if (!currentWorkspaceId) return;
    if (currentSessionId && sessions && !sessions.some((s) => s.id === currentSessionId)) {
      setCurrentSessionId(null);
    }
  }, [sessions, currentWorkspaceId, currentSessionId, setCurrentSessionId]);

  // ---------- Workspace ----------
  const createWsMutation = useMutation({
    mutationFn: () => workspaceApi.create(wsName.trim()),
    onSuccess: (ws) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setCreatingWs(false);
      setWsName("");
      setCurrentWorkspaceId(ws.id);
      antdMessage.success(`已创建 Workspace「${ws.name}」`);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const deleteWsMutation = useMutation({
    mutationFn: (id: string) => workspaceApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setDeletingWs(null);
      if (currentWorkspaceId === deletingWs?.id) setCurrentWorkspaceId(null);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  // ---------- Session ----------
  const createSessionMutation = useMutation({
    mutationFn: () => sessionApi.create(currentWorkspaceId!, sessionName.trim()),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", currentWorkspaceId] });
      setCreatingSession(false);
      setSessionName("新会话");
      setCurrentSessionId(session.id);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      sessionApi.update(input.id, { title: input.title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", currentWorkspaceId] });
      setRenaming(null);
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (id: string) => sessionApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", currentWorkspaceId] });
      setDeletingSession(null);
    },
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--color-surface)",
        minHeight: 0,
      }}
    >
      {/* ===== 顶部：工作区选择行 ===== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 8px 6px 12px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--color-text-tertiary)",
            whiteSpace: "nowrap",
            marginRight: 2,
          }}
        >
          工作区
        </span>
        <Select
          variant="borderless"
          size="small"
          value={currentWorkspaceId ?? undefined}
          onChange={(id) => setCurrentWorkspaceId(id)}
          options={(workspaces ?? []).map((w) => ({ value: w.id, label: w.name }))}
          placeholder="选择 Workspace"
          style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}
          popupMatchSelectWidth={false}
        />
        <button
          type="button"
          title="新建 Workspace"
          onClick={() => {
            setWsName("");
            setCreatingWs(true);
          }}
          style={iconBtnStyle}
        >
          <PlusOutlined style={{ fontSize: 11 }} />
        </button>
        <button
          type="button"
          title="删除当前 Workspace"
          disabled={!currentWorkspaceId}
          onClick={() => {
            const ws = workspaces?.find((w) => w.id === currentWorkspaceId);
            if (ws) setDeletingWs(ws);
          }}
          style={{
            ...iconBtnStyle,
            opacity: currentWorkspaceId ? 1 : 0.3,
            cursor: currentWorkspaceId ? "pointer" : "not-allowed",
          }}
        >
          <DeleteOutlined style={{ fontSize: 11 }} />
        </button>
      </div>

      {/* ===== 新会话按钮 ===== */}
      <div style={{ padding: "0 8px 4px", flexShrink: 0 }}>
        <Button
          icon={<PlusOutlined />}
          block
          size="small"
          onClick={() => {
            if (!currentWorkspaceId) {
              antdMessage.info("请先选择 Workspace");
              return;
            }
            setSessionName("新会话");
            setCreatingSession(true);
          }}
          style={{ justifyContent: "flex-start", paddingLeft: 10 }}
        >
          新会话
        </Button>
      </div>

      {/* ===== 会话列表（内部滚动） ===== */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "2px 8px 8px" }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--color-text-tertiary)",
            padding: "6px 4px 4px",
            whiteSpace: "nowrap",
          }}
        >
          最近
        </div>
        {sessions?.map((session) => {
          const active = session.id === currentSessionId;
          return (
            <Dropdown
              key={session.id}
              trigger={["contextMenu"]}
              menu={{
                items: [
                  { key: "rename", label: "重命名", icon: <EditOutlined /> },
                  { type: "divider" },
                  { key: "delete", label: "删除", icon: <DeleteOutlined />, danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === "rename") {
                    setRenameValue(session.title);
                    setRenaming(session);
                  } else if (key === "delete") {
                    setDeletingSession(session);
                  }
                },
              }}
            >
              <div
                onClick={() => setCurrentSessionId(session.id)}
                onDoubleClick={() => {
                  setRenameValue(session.title);
                  setRenaming(session);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  marginBottom: 1,
                  background: active ? "var(--color-surface-secondary)" : "transparent",
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12.5,
                      color: "var(--color-text-primary)",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {session.status === "running" && (
                      <LoadingOutlined style={{ fontSize: 10, color: "var(--color-warning)" }} />
                    )}
                    {session.status === "error" && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: "var(--color-error)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {session.title}
                    </span>
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--color-text-tertiary)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {formatRelativeTime(session.updatedAt)}
                </span>
              </div>
            </Dropdown>
          );
        })}
        {sessions?.length === 0 && (
          <div
            style={{
              padding: "14px 10px",
              textAlign: "center",
              color: "var(--color-text-tertiary)",
              fontSize: 12,
            }}
          >
            暂无会话，点击「新会话」开始
          </div>
        )}
        {!currentWorkspaceId && (
          <div
            style={{
              padding: "14px 10px",
              textAlign: "center",
              color: "var(--color-text-tertiary)",
              fontSize: 12,
            }}
          >
            请先选择 Workspace
          </div>
        )}
      </div>

      {/* ===== 底部：设置入口 ===== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 8px",
          borderTop: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          style={{
            ...iconBtnStyle,
            fontSize: 12,
            color: "var(--color-text-secondary)",
            padding: "4px 8px",
          }}
        >
          <SlidersOutlined style={{ fontSize: 12 }} />
          <span style={{ marginLeft: 6 }}>模型设置</span>
        </button>
      </div>

      {/* ===== 弹窗：新建 Workspace ===== */}
      <Modal
        open={creatingWs}
        title="创建 Workspace"
        width={380}
        okText="创建"
        cancelText="取消"
        confirmLoading={createWsMutation.isPending}
        onOk={() => {
          if (!wsName.trim()) {
            antdMessage.warning("请输入名称");
            return;
          }
          createWsMutation.mutate();
        }}
        onCancel={() => setCreatingWs(false)}
        destroyOnClose
      >
        <Input
          value={wsName}
          onChange={(e) => setWsName(e.target.value)}
          placeholder="如：东京旅游视频"
          onPressEnter={() => {
            if (wsName.trim()) createWsMutation.mutate();
          }}
          prefix={<AppstoreOutlined style={{ color: "var(--color-text-tertiary)" }} />}
        />
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-tertiary)" }}>
          创建后自动生成 svh.project.json 与 VIDEO_AGENTS.md
        </div>
      </Modal>

      {/* ===== 弹窗：新建会话（可命名） ===== */}
      <Modal
        open={creatingSession}
        title="新建会话"
        width={380}
        okText="创建"
        cancelText="取消"
        confirmLoading={createSessionMutation.isPending}
        onOk={() => {
          if (!sessionName.trim()) {
            antdMessage.warning("请输入会话名称");
            return;
          }
          createSessionMutation.mutate();
        }}
        onCancel={() => setCreatingSession(false)}
        destroyOnClose
      >
        <Input
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          placeholder="会话名称，如：脚本创作"
          onPressEnter={() => {
            if (sessionName.trim()) createSessionMutation.mutate();
          }}
          autoFocus
        />
      </Modal>

      {/* ===== 弹窗：删除 Workspace ===== */}
      <Modal
        open={!!deletingWs}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <CloseCircleFilled style={{ color: "var(--color-error)" }} />
            删除 Workspace
          </span>
        }
        width={400}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={deleteWsMutation.isPending}
        onOk={() => deletingWs && deleteWsMutation.mutate(deletingWs.id)}
        onCancel={() => setDeletingWs(null)}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          确定删除 Workspace <b>{deletingWs?.name}</b> 吗？
          <br />
          其下全部会话、消息与工作区文件将被删除，此操作不可恢复。
        </div>
      </Modal>

      {/* ===== 弹窗：重命名会话 ===== */}
      <Modal
        open={!!renaming}
        title="重命名会话"
        width={360}
        okText="保存"
        cancelText="取消"
        onOk={() =>
          renaming &&
          renameValue.trim() &&
          renameMutation.mutate({ id: renaming.id, title: renameValue.trim() })
        }
        onCancel={() => setRenaming(null)}
        destroyOnClose
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={() =>
            renaming &&
            renameValue.trim() &&
            renameMutation.mutate({ id: renaming.id, title: renameValue.trim() })
          }
          placeholder="会话标题"
          autoFocus
        />
      </Modal>

      {/* ===== 弹窗：删除会话 ===== */}
      <Modal
        open={!!deletingSession}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <CloseCircleFilled style={{ color: "var(--color-error)" }} />
            删除会话
          </span>
        }
        width={380}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => deletingSession && deleteSessionMutation.mutate(deletingSession.id)}
        onCancel={() => setDeletingSession(null)}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          确定删除会话 <b>{deletingSession?.title}</b>{" "}
          吗？该会话的全部消息记录将被移除，此操作不可恢复。
        </div>
      </Modal>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "var(--color-text-tertiary)",
  cursor: "pointer",
  borderRadius: 4,
  width: 26,
  height: 26,
  flexShrink: 0,
};
