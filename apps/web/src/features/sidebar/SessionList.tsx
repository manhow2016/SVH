import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Modal, Tooltip, message as antdMessage } from "antd";
import {
  AppstoreOutlined,
  CloseCircleFilled,
  DeleteOutlined,
  EditOutlined,
  LoadingOutlined,
  MessageOutlined,
  PlusOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import type { Session } from "@svh/shared";
import { sessionApi } from "../../api/session";
import { workspaceApi } from "../../api/workspace";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useSessionStore } from "../../stores/session-store";
import { useUIStore } from "../../stores/ui-store";
import { useMembershipStore } from "../../stores/membership-store";
import { formatRelativeTime } from "../../lib/format";

/**
 * 会话列表（制作中心左侧栏）：
 * 隐藏工作区概念（自动绑定第一个工作区），扁平展示会话；
 * 顶部「新会话」按钮 + 底部设置入口；会话支持重命名/删除；
 * 无工作区时引导创建（会员资源限制沿用后端校验）。
 */
export function SessionList() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, setCurrentWorkspaceId } = useWorkspaceStore();
  const { currentSessionId, setCurrentSessionId } = useSessionStore();
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionName, setSessionName] = useState("新会话");
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);
  const [creatingWs, setCreatingWs] = useState(false);
  const [wsName, setWsName] = useState("");

  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaceApi.list(),
  });

  // 默认选中第一个工作区（工作区概念已从 UI 隐藏；会话都挂在它下面）
  useEffect(() => {
    if (!currentWorkspaceId && workspaces && workspaces.length > 0) {
      setCurrentWorkspaceId(workspaces[0]!.id);
    }
  }, [workspaces, currentWorkspaceId, setCurrentWorkspaceId]);

  const { data: sessions } = useQuery({
    queryKey: ["sessions", currentWorkspaceId],
    queryFn: () => sessionApi.list(currentWorkspaceId!),
    enabled: !!currentWorkspaceId,
  });

  // ---------- 工作区创建（无工作区空态） ----------
  const createWsMutation = useMutation({
    mutationFn: () => workspaceApi.create(wsName.trim()),
    onSuccess: (ws) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setCreatingWs(false);
      setWsName("");
      setCurrentWorkspaceId(ws.id);
      antdMessage.success(`已创建工作区「${ws.name}」`);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  // ---------- 会话操作 ----------
  const reloadSessions = () => {
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  };

  const createSessionMutation = useMutation({
    mutationFn: () => sessionApi.create(currentWorkspaceId!, sessionName.trim()),
    onSuccess: (session) => {
      reloadSessions();
      setCreatingSession(false);
      setSessionName("新会话");
      setCurrentSessionId(session.id);
      antdMessage.success("已新建会话");
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      sessionApi.update(input.id, { title: input.title }),
    onSuccess: (_res, input) => {
      reloadSessions();
      void queryClient.invalidateQueries({ queryKey: ["session", input.id] });
      setRenaming(null);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (id: string) => sessionApi.remove(id),
    onSuccess: () => {
      reloadSessions();
      setDeletingSession(null);
      if (currentSessionId === deletingSession?.id) setCurrentSessionId(null);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 10px",
    borderRadius: 6,
    cursor: "pointer",
    background: active ? "rgba(59,111,224,.08)" : "transparent",
    color: "var(--color-text-primary)",
  });

  const items = useMemo(() => sessions ?? [], [sessions]);

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
      {/* 新会话（无工作区时引导创建） */}
      {!currentWorkspaceId && workspaces && workspaces.length === 0 ? (
        <div style={{ padding: "6px 10px", flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => {
              setWsName("");
              setCreatingWs(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              width: "100%",
              height: 34,
              borderRadius: 6,
              border: "none",
              background: "var(--color-primary)",
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 1px 3px rgba(0,0,0,.12)",
            }}
          >
            <PlusOutlined style={{ fontSize: 13 }} />
            创建工作区
          </button>
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-tertiary)", textAlign: "center" }}>
            创建后即可开始新建会话
          </div>
        </div>
      ) : (
        <div style={{ padding: "6px 10px", flexShrink: 0 }}>
          <button
            type="button"
            disabled={!currentWorkspaceId || !sessions}
            onClick={() => {
              setSessionName("新会话");
              setCreatingSession(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              width: "100%",
              height: 34,
              borderRadius: 6,
              border: "none",
              background: currentWorkspaceId ? "var(--color-primary)" : "var(--color-border)",
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: currentWorkspaceId ? "pointer" : "not-allowed",
              boxShadow: currentWorkspaceId ? "0 1px 3px rgba(0,0,0,.12)" : "none",
            }}
          >
            <PlusOutlined style={{ fontSize: 13 }} />
            新会话
          </button>
        </div>
      )}

      {/* 分组标题 */}
      <div style={{ padding: "2px 10px 4px", flexShrink: 0 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--color-text-tertiary)",
            letterSpacing: 0.4,
          }}
        >
          会话
        </span>
      </div>

      {/* 会话列表 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 6px 8px" }}>
        {items.length === 0 ? (
          <div
            style={{
              padding: "14px 10px",
              textAlign: "center",
              color: "var(--color-text-tertiary)",
              fontSize: 12,
            }}
          >
            暂无会话，点击上方「新会话」开始
          </div>
        ) : (
          items.map((s) => {
            const active = s.id === currentSessionId;
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => setCurrentSessionId(s.id)}
                onContextMenu={(e) => e.preventDefault()}
                style={rowStyle(active)}
                onDoubleClick={() => {
                  setRenameValue(s.title);
                  setRenaming(s);
                }}
              >
                {s.status === "running" ? (
                  <LoadingOutlined style={{ fontSize: 11, color: "var(--color-warning)", flexShrink: 0 }} />
                ) : (
                  <MessageOutlined
                    style={{
                      fontSize: 12,
                      color: active ? "var(--color-primary)" : "var(--color-text-tertiary)",
                      flexShrink: 0,
                    }}
                  />
                )}
                <Tooltip title={s.title} placement="top" mouseEnterDelay={0.3}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 12.5,
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {s.title}
                  </span>
                </Tooltip>
                {s.status === "error" && (
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
                    fontSize: 11,
                    color: "var(--color-text-tertiary)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {formatRelativeTime(s.updatedAt)}
                </span>
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenameValue(s.title);
                    setRenaming(s);
                  }}
                  style={iconBtnStyle}
                >
                  <EditOutlined style={{ fontSize: 11 }} />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingSession(s);
                  }}
                  style={iconBtnStyle}
                >
                  <DeleteOutlined style={{ fontSize: 11 }} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* 底部设置 */}
      <div style={{ padding: "0 8px 10px", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            height: 34,
            borderRadius: 6,
            border: "none",
            background: "var(--color-primary)",
            color: "#fff",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 1px 3px rgba(0,0,0,.12)",
          }}
        >
          <SettingOutlined style={{ fontSize: 13 }} />
          设置
        </button>
      </div>

      {/* 弹窗：创建工作区（无工作区时引导；会员资源限制沿用后端校验） */}
      <Modal
        open={creatingWs}
        title="创建工作区"
        width={380}
        okText="创建"
        cancelText="取消"
        confirmLoading={createWsMutation.isPending}
        onOk={() => {
          if (!wsName.trim()) {
            antdMessage.warning("请输入名称");
            return;
          }
          // 会员资源限制：达到等级上限提示升级（后端仍会校验）
          const limit = useMembershipStore.getState().maxWorkspaces();
          const count = workspaces?.length ?? 0;
          if (limit !== undefined && limit >= 0 && count >= limit) {
            antdMessage.warning("已达当前等级的工作区数量上限，可前往会员中心升级");
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
          placeholder="如：我的短剧项目"
          onPressEnter={() => {
            if (wsName.trim()) createWsMutation.mutate();
          }}
          prefix={<AppstoreOutlined style={{ color: "var(--color-text-tertiary)" }} />}
          autoFocus
        />
      </Modal>

      {/* 弹窗：新建会话 */}
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

      {/* 弹窗：重命名会话 */}
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

      {/* 弹窗：删除会话 */}
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
        confirmLoading={deleteSessionMutation.isPending}
        onOk={() => deletingSession && deleteSessionMutation.mutate(deletingSession.id)}
        onCancel={() => setDeletingSession(null)}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          确定删除会话 <b>{deletingSession?.title}</b> 吗？该会话的全部消息记录将被移除，此操作不可恢复。
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
  width: 22,
  height: 22,
  flexShrink: 0,
  opacity: 0.55,
};
