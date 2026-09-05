import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dropdown, Input, Modal, Tree, message as antdMessage } from "antd";
import type { DataNode } from "antd/es/tree";
import {
  AppstoreOutlined,
  CloseCircleFilled,
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  LoadingOutlined,
  MessageOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import type { Session } from "@svh/shared";
import { workspaceApi } from "../../api/workspace";
import { sessionApi } from "../../api/session";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useSessionStore } from "../../stores/session-store";
import { useUIStore } from "../../stores/ui-store";
import { formatRelativeTime } from "../../lib/format";
import { AssetsModal } from "../assets/AssetsModal";
import type { Workspace } from "../../types/api-types";

/**
 * 左侧边栏（树形排列）：
 * Workspace（文件夹图标）为根节点，展开显示其会话（对话图标 + 相对时间 + 状态），
 * 每棵子树末尾有「＋ 新会话」占位节点；顶部可新建 Workspace，设置入口在顶部标签栏。
 */
export function WorkspaceSidebar() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, setCurrentWorkspaceId } = useWorkspaceStore();
  const { currentSessionId, setCurrentSessionId } = useSessionStore();
  const createWorkspaceSignal = useUIStore((s) => s.createWorkspaceSignal);

  // 全局资产库弹窗
  const [assetsOpen, setAssetsOpen] = useState(false);

  // 弹窗状态
  const [creatingWs, setCreatingWs] = useState(false);
  const [wsName, setWsName] = useState("");
  const [deletingWs, setDeletingWs] = useState<Workspace | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionTargetWs, setSessionTargetWs] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState("新会话");
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);

  // 树展开状态
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  // 非当前 workspace 懒加载的会话缓存
  const [extraSessions, setExtraSessions] = useState<Record<string, Session[]>>({});

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
  const { data: currentSessions } = useQuery({
    queryKey: ["sessions", currentWorkspaceId],
    queryFn: () => sessionApi.list(currentWorkspaceId!),
    enabled: !!currentWorkspaceId,
  });

  // 当前工作区的会话同步缓存到 extraSessions：
  // 切换工作区后，原工作区变回「非当前」时仍有数据显示，不会出现「收起」。
  useEffect(() => {
    if (currentWorkspaceId && currentSessions) {
      setExtraSessions((prev) => ({ ...prev, [currentWorkspaceId]: currentSessions }));
    }
  }, [currentWorkspaceId, currentSessions]);

  // 当前 workspace 的树节点默认展开
  useEffect(() => {
    if (!currentWorkspaceId) return;
    setExpandedKeys((prev) => {
      const wsKey = `ws:${currentWorkspaceId}`;
      return prev.includes(wsKey) ? prev : [...prev, wsKey];
    });
  }, [currentWorkspaceId]);

  // ---------- 会话懒加载（非当前 workspace） ----------
  const loadSessions = useCallback(
    async (wsId: string) => {
      if (wsId === currentWorkspaceId) return;
      const data = await queryClient.fetchQuery({
        queryKey: ["sessions", wsId],
        queryFn: () => sessionApi.list(wsId),
      });
      setExtraSessions((prev) => ({ ...prev, [wsId]: data }));
    },
    [currentWorkspaceId, queryClient],
  );

  // ---------- Workspace 操作 ----------
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

  const deleteWsMutation = useMutation({
    mutationFn: (id: string) => workspaceApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setExtraSessions({});
      setDeletingWs(null);
      if (currentWorkspaceId === deletingWs?.id) {
        setCurrentWorkspaceId(null);
        setCurrentSessionId(null);
      }
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  // ---------- Session 操作 ----------
  const reloadSessions = () => {
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    const keys = expandedKeys;
    for (const key of keys) {
      if (key.startsWith("ws:")) void loadSessions(key.slice(3));
    }
  };

  const createSessionMutation = useMutation({
    mutationFn: () => sessionApi.create(sessionTargetWs ?? currentWorkspaceId!, sessionName.trim()),
    onSuccess: (session) => {
      reloadSessions();
      setCreatingSession(false);
      setSessionName("新会话");
      setCurrentSessionId(session.id);
      setCurrentWorkspaceId(session.workspaceId);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      sessionApi.update(input.id, { title: input.title }),
    onSuccess: () => {
      reloadSessions();
      setRenaming(null);
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (id: string) => sessionApi.remove(id),
    onSuccess: () => {
      reloadSessions();
      setDeletingSession(null);
    },
  });

  // ---------- 树数据（图标内置在 title 中：图标左、标题右） ----------
  const treeData: DataNode[] = useMemo(() => {
    const wsNodes = (workspaces ?? []).map((ws) => {
      const sessions = extraSessions[ws.id] ?? (ws.id === currentWorkspaceId ? currentSessions : undefined);
      const children: DataNode[] = (sessions ?? []).map((s) => ({
        key: `ses:${s.id}`,
        isLeaf: true,
        title: (
          <SessionNodeTitle
            session={s}
            active={s.id === currentSessionId}
            onRename={() => {
              setRenameValue(s.title);
              setRenaming(s);
            }}
            onDelete={() => setDeletingSession(s)}
          />
        ),
      }));
      children.push({
        key: `new:${ws.id}`,
        isLeaf: true,
        title: (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              color: "var(--color-text-tertiary)",
            }}
          >
            <PlusOutlined style={{ fontSize: 12 }} />
            <span>新会话</span>
          </span>
        ),
      });
      return {
        key: `ws:${ws.id}`,
        isLeaf: false,
        title: (
          <WsNodeTitle
            name={ws.name}
            active={ws.id === currentWorkspaceId}
            onDelete={() => setDeletingWs(ws)}
          />
        ),
        children,
      };
    });
    return wsNodes;
  }, [workspaces, currentSessions, extraSessions, currentWorkspaceId, currentSessionId]);

  const selectedKeys = useMemo(() => {
    const keys: string[] = [];
    if (currentWorkspaceId) keys.push(`ws:${currentWorkspaceId}`);
    if (currentSessionId) keys.push(`ses:${currentSessionId}`);
    return keys;
  }, [currentWorkspaceId, currentSessionId]);

  const findWsOfSession = useCallback(
    (sessionId: string): string | undefined => {
      if (currentSessions?.some((s) => s.id === sessionId)) return currentWorkspaceId ?? undefined;
      for (const [wsId, list] of Object.entries(extraSessions)) {
        if (list.some((s) => s.id === sessionId)) return wsId;
      }
      return undefined;
    },
    [currentSessions, currentWorkspaceId, extraSessions],
  );

  const handleExpand = (keys: React.Key[]) => {
    const next = keys as string[];
    const newly = next.filter((k) => !expandedKeys.includes(k));
    setExpandedKeys(next);
    for (const key of newly) {
      if (key.startsWith("ws:")) {
        const wsId = key.slice(3);
        if (wsId !== currentWorkspaceId && !extraSessions[wsId]) void loadSessions(wsId);
      }
    }
  };

  const handleSelect = (keys: React.Key[]) => {
    const key = keys[0] as string | undefined;
    if (!key) return;
    if (key.startsWith("ws:")) {
      const wsId = key.slice(3);
      setCurrentWorkspaceId(wsId);
      setExpandedKeys((prev) => (prev.includes(`ws:${wsId}`) ? prev : [...prev, `ws:${wsId}`]));
    } else if (key.startsWith("ses:")) {
      const sid = key.slice(4);
      const wsId = findWsOfSession(sid);
      if (wsId) setCurrentWorkspaceId(wsId);
      setCurrentSessionId(sid);
    } else if (key.startsWith("new:")) {
      const wsId = key.slice(4);
      setSessionTargetWs(wsId);
      setSessionName("新会话");
      setCreatingSession(true);
    }
  };

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
      {/* ===== 顶部：标题 + 我的资产 + 新建 Workspace ===== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 34,
          padding: "0 8px 0 12px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--color-text-tertiary)",
            letterSpacing: 0.4,
          }}
        >
          工作区
        </span>
        <button
          type="button"
          onClick={() => setAssetsOpen(true)}
          title="我的资产"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 26,
            padding: "0 8px",
            borderRadius: 4,
            background: "transparent",
            border: "none",
            color: "var(--color-text-secondary)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <AppstoreOutlined style={{ fontSize: 12 }} />
          我的资产
        </button>
        <button
          type="button"
          title="新建工作区"
          onClick={() => {
            setWsName("");
            setCreatingWs(true);
          }}
          style={iconBtnStyle}
        >
          <PlusOutlined style={{ fontSize: 11 }} />
        </button>
      </div>

      {/* ===== 树：Workspace → Sessions ===== */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 6px 8px" }}>
        {workspaces && workspaces.length > 0 ? (
          <Tree
            treeData={treeData}
            expandedKeys={expandedKeys}
            onExpand={handleExpand}
            selectedKeys={selectedKeys}
            onSelect={handleSelect}
            showIcon={false}
            blockNode
            style={{ background: "transparent", fontSize: 12.5 }}
          />
        ) : (
          <div
            style={{
              padding: "14px 10px",
              textAlign: "center",
              color: "var(--color-text-tertiary)",
              fontSize: 12,
            }}
          >
            暂无工作区，点击右上「＋」创建
          </div>
        )}
      </div>

      {/* ===== 弹窗：新建 Workspace ===== */}
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

      {/* ===== 弹窗：删除工作区 ===== */}
      <Modal
        open={!!deletingWs}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <CloseCircleFilled style={{ color: "var(--color-error)" }} />
            删除工作区
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
          确定删除工作区 <b>{deletingWs?.name}</b> 吗？
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

      {/* ===== 全局资产库弹窗 ===== */}
      <AssetsModal open={assetsOpen} onClose={() => setAssetsOpen(false)} />
    </div>
  );
}

/** Workspace 节点标题（图标左、标题右；右键：删除） */
function WsNodeTitle({
  name,
  active,
  onDelete,
}: {
  name: string;
  active: boolean;
  onDelete: () => void;
}) {
  return (
    <Dropdown
      trigger={["contextMenu"]}
      menu={{
        items: [{ key: "delete", label: "删除工作区", icon: <DeleteOutlined />, danger: true }],
        onClick: ({ key }) => {
          if (key === "delete") onDelete();
        },
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          minWidth: 0,
        }}
      >
        <FolderOutlined
          style={{
            fontSize: 12,
            color: active ? "var(--color-primary)" : "var(--color-text-tertiary)",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12.5,
            fontWeight: active ? 600 : 400,
            color: "var(--color-text-primary)",
          }}
        >
          {name}
        </span>
      </span>
    </Dropdown>
  );
}

/** Session 节点标题（图标左、标题右 + 状态 + 时间；右键：重命名/删除） */
function SessionNodeTitle({
  session,
  active,
  onRename,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Dropdown
      trigger={["contextMenu"]}
      menu={{
        items: [
          { key: "rename", label: "重命名", icon: <EditOutlined /> },
          { type: "divider" },
          { key: "delete", label: "删除", icon: <DeleteOutlined />, danger: true },
        ],
        onClick: ({ key }) => {
          if (key === "rename") onRename();
          else if (key === "delete") onDelete();
        },
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          minWidth: 0,
        }}
      >
        {session.status === "running" ? (
          <LoadingOutlined style={{ fontSize: 11, color: "var(--color-warning)", flexShrink: 0 }} />
        ) : (
          <MessageOutlined
            style={{ fontSize: 12, color: "var(--color-text-tertiary)", flexShrink: 0 }}
          />
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12.5,
            fontWeight: active ? 600 : 400,
            color: "var(--color-text-primary)",
          }}
        >
          {session.title}
        </span>
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
            fontSize: 11,
            color: "var(--color-text-tertiary)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {formatRelativeTime(session.updatedAt)}
        </span>
      </span>
    </Dropdown>
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
