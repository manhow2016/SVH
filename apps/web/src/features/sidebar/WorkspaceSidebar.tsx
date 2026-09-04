import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Modal, message as antdMessage } from "antd";
import {
  AppstoreOutlined,
  CloseCircleFilled,
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import type { Session, SessionStatus } from "@svh/shared";
import { workspaceApi } from "../../api/workspace";
import { sessionApi } from "../../api/session";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useSessionStore } from "../../stores/session-store";
import { useUIStore } from "../../stores/ui-store";
import { formatTime } from "../../lib/format";
import type { Workspace } from "../../types/api-types";

function StatusBadge({ status }: { status: SessionStatus }) {
  const color =
    status === "running"
      ? "var(--color-warning)"
      : status === "error"
        ? "var(--color-error)"
        : "var(--color-success)";
  const label = status === "running" ? "运行中" : status === "error" ? "异常" : "";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        color: "var(--color-text-tertiary)",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

/**
 * 左侧侧边栏（v1 布局调整）：
 * 上部 = Workspace 列表（可新建/删除，点击切换）；
 * 下部 = 当前 Workspace 的会话列表（新建可命名，双击/菜单重命名，菜单删除）。
 */
export function WorkspaceSidebar() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, setCurrentWorkspaceId } = useWorkspaceStore();
  const { currentSessionId, setCurrentSessionId } = useSessionStore();
  const createWorkspaceSignal = useUIStore((s) => s.createWorkspaceSignal);

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
  const currentWorkspace = workspaces?.find((w) => w.id === currentWorkspaceId);

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
      {/* ===== Workspace 区（固定高度，内部滚动） ===== */}
      <div
        style={{
          flex: "0 1 auto",
          maxHeight: "42%",
          minHeight: 96,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <SectionHeader
          title="工作区"
          actionTitle="新建 Workspace"
          onAction={() => {
            setWsName("");
            setCreatingWs(true);
          }}
        />
        <div style={{ flex: 1, overflowY: "auto", padding: "2px 8px 8px" }}>
          {workspaces?.map((ws) => {
            const active = ws.id === currentWorkspaceId;
            return (
              <div
                key={ws.id}
                onClick={() => setCurrentWorkspaceId(ws.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  marginBottom: 2,
                  background: active ? "var(--color-surface-secondary)" : "transparent",
                  border: `1px solid ${active ? "var(--color-border)" : "transparent"}`,
                }}
              >
                <FolderOutlined
                  style={{ color: active ? "var(--color-primary)" : "var(--color-text-tertiary)" }}
                />
                <span
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    color: "var(--color-text-primary)",
                    fontWeight: active ? 600 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {ws.name}
                </span>
                <span
                  role="button"
                  title="删除 Workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingWs(ws);
                  }}
                  style={{ ...iconBtn, opacity: active ? 1 : 0 }}
                >
                  <DeleteOutlined style={{ fontSize: 11 }} />
                </span>
              </div>
            );
          })}
          {workspaces?.length === 0 && (
            <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--color-text-tertiary)" }}>
              暂无 Workspace，点击右上「+」创建
            </div>
          )}
        </div>
      </div>

      {/* ===== 会话区（占满剩余高度，内部滚动） ===== */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          borderTop: "1px solid var(--color-border)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <SectionHeader
          title={currentWorkspace ? `会话 · ${currentWorkspace.name}` : "会话"}
          actionTitle="新建会话"
          disabled={!currentWorkspaceId}
          onAction={() => {
            if (!currentWorkspaceId) return;
            setSessionName("新会话");
            setCreatingSession(true);
          }}
        />
        <div style={{ flex: 1, overflowY: "auto", padding: "2px 8px 8px" }}>
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
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    marginBottom: 2,
                    background: active ? "var(--color-surface-secondary)" : "transparent",
                    border: `1px solid ${active ? "var(--color-border)" : "transparent"}`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--color-text-primary)",
                      fontWeight: active ? 600 : 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {session.title}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: 2,
                    }}
                  >
                    <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
                      {formatTime(session.updatedAt)}
                    </span>
                    <StatusBadge status={session.status} />
                  </div>
                </div>
              </Dropdown>
            );
          })}
          {sessions?.length === 0 && (
            <div
              style={{
                padding: "18px 10px",
                textAlign: "center",
                color: "var(--color-text-tertiary)",
                fontSize: 12,
              }}
            >
              该 Workspace 暂无会话，点击「+」新建
            </div>
          )}
          {!currentWorkspaceId && (
            <div
              style={{
                padding: "18px 10px",
                textAlign: "center",
                color: "var(--color-text-tertiary)",
                fontSize: 12,
              }}
            >
              请先选择 Workspace
            </div>
          )}
        </div>
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

const iconBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-text-tertiary)",
  cursor: "pointer",
  transition: "opacity .12s",
};

function SectionHeader({
  title,
  actionTitle,
  disabled,
  onAction,
}: {
  title: string;
  actionTitle: string;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 34,
        padding: "0 10px 0 12px",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 12,
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      <Button
        type="text"
        size="small"
        icon={<PlusOutlined />}
        disabled={disabled}
        title={actionTitle}
        style={{ color: "var(--color-text-secondary)", width: 26, height: 26, padding: 0 }}
        onClick={onAction}
      />
    </div>
  );
}
