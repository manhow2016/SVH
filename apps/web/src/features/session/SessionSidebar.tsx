import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Modal, message as antdMessage } from "antd";
import { CloseCircleFilled, DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { sessionApi } from "../../api/session";
import { workspaceApi } from "../../api/workspace";
import { useSessionStore } from "../../stores/session-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { formatTime } from "../../lib/format";
import type { Session, SessionStatus } from "@svh/shared";

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
 * Session Sidebar（文档 §35）：Workspace 名称 + New Session + Session 列表。
 * 点击切换；双击或菜单重命名；菜单删除。
 */
export function SessionSidebar() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaceApi.list(),
  });
  const currentWorkspace = workspaces?.find((w) => w.id === workspaceId);

  const queryClient = useQueryClient();
  const { currentSessionId, setCurrentSessionId } = useSessionStore();
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<Session | null>(null);

  const { data: sessions } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => sessionApi.list(workspaceId!),
    enabled: !!workspaceId,
  });

  // 当前会话必须属于当前 workspace
  useEffect(() => {
    if (!workspaceId) return;
    if (currentSessionId && sessions && !sessions.some((s) => s.id === currentSessionId)) {
      setCurrentSessionId(null);
    }
  }, [sessions, workspaceId, currentSessionId, setCurrentSessionId]);

  const createMutation = useMutation({
    mutationFn: () => sessionApi.create(workspaceId!),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] });
      setCurrentSessionId(session.id);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      sessionApi.update(input.id, { title: input.title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] });
      setRenaming(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => sessionApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] });
      setDeleting(null);
    },
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--color-surface)",
      }}
    >
      {/* 顶部：Workspace + New Session */}
      <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--color-border)" }}>
        <div
          style={{
            fontSize: 12,
            color: "var(--color-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginBottom: 10,
            fontWeight: 500,
          }}
        >
          {currentWorkspace?.name ?? "选择 Workspace"}
        </div>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          block
          onClick={() => createMutation.mutate()}
          loading={createMutation.isPending}
          disabled={!workspaceId}
        >
          新会话
        </Button>
      </div>

      {/* 会话列表 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}>
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
                    setDeleting(session);
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
                  transition: "background .12s",
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
            暂无会话，点击上方「新会话」开始
          </div>
        )}
      </div>

      {/* 重命名 Modal */}
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

      {/* 删除确认 Modal */}
      <Modal
        open={!!deleting}
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
        onOk={() => deleting && deleteMutation.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          确定删除会话 <b>{deleting?.title}</b> 吗？该会话的全部消息记录将被移除，此操作不可恢复。
        </div>
      </Modal>
    </div>
  );
}
