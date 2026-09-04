import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Empty, Input, Modal, Skeleton, Tree, message as antdMessage } from "antd";
import {
  FileTextOutlined,
  FolderAddOutlined,
  FolderOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { fileApi } from "../../api/files";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useUIStore } from "../../stores/ui-store";
import type { FileEntry } from "../../types/api-types";

/** 新建文件夹时自动创建的资产子目录（4 种资产类别） */
const ASSET_DIRS = ["角色", "场景", "道具", "音色"];

interface TreeNode {
  key: string;
  title: string;
  isLeaf: boolean;
  icon?: React.ReactNode;
  children?: TreeNode[];
}

/**
 * Workspace Explorer（参考 DeepSeek Harness 文件树）：
 * 顶部搜索框（按文件名过滤）+ 标题行工具 + 懒加载目录树。
 * 新建文件夹时自动创建「角色 / 场景 / 道具 / 音色」四个资产子目录。
 */
export function WorkspaceExplorer() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { selectedFilePath, setSelectedFilePath } = useWorkspaceStore();
  const filesRevision = useUIStore((s) => s.filesRevision);
  const queryClient = useQueryClient();
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadDir = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      setLoadingDirs((prev) => ({ ...prev, [path]: true }));
      try {
        const entries = await queryClient.fetchQuery({
          queryKey: ["files", workspaceId, path],
          queryFn: () => fileApi.list(workspaceId, path),
        });
        setDirs((prev) => ({ ...prev, [path]: entries }));
      } catch (err) {
        console.error("[svh] 文件目录加载失败:", path, err);
        antdMessage.error(`文件列表加载失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoadingDirs((prev) => ({ ...prev, [path]: false }));
      }
    },
    [workspaceId, queryClient],
  );

  // 切换 workspace：清空并加载根目录
  useEffect(() => {
    setDirs({});
    setExpandedKeys([]);
    setSelectedFilePath(null);
    void loadDir(".");
  }, [workspaceId, loadDir, setSelectedFilePath]);

  // workspace.changed / 手动刷新：重载已展开目录
  useEffect(() => {
    if (!workspaceId) return;
    const known = Object.keys(dirs);
    if (known.length === 0) {
      void loadDir(".");
    } else {
      for (const p of known) void loadDir(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesRevision, workspaceId]);

  const treeData = useMemo(() => buildNodes(".", dirs), [dirs]);

  // 文件名搜索过滤（保留匹配节点的祖先目录）
  const filteredTreeData = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return treeData;
    return filterTree(treeData, kw);
  }, [treeData, keyword]);

  const onSearch = (value: string) => {
    setKeyword(value);
    const kw = value.trim().toLowerCase();
    if (kw) {
      // 自动展开包含匹配的目录
      const keys: string[] = [];
      collectDirKeys(treeData, kw, keys);
      setExpandedKeys((prev) => Array.from(new Set([...prev, ...keys])));
    }
  };

  const refresh = () => {
    // 清除查询缓存后重载
    void queryClient.invalidateQueries({ queryKey: ["files", workspaceId] });
    const known = Object.keys(dirs);
    if (known.length === 0) void loadDir(".");
    else for (const p of known) void loadDir(p);
  };

  const createMutation = useMutation({
    mutationFn: () => fileApi.mkdir(workspaceId!, newName.trim(), ASSET_DIRS),
    onSuccess: (result) => {
      antdMessage.success(`已创建 ${result.path}`);
      setCreating(false);
      setNewName("");
      refresh();
      // 展开新文件夹使其子目录可见
      setExpandedKeys((prev) => (prev.includes(result.path) ? prev : [...prev, result.path]));
    },
    onError: (err) => antdMessage.error((err as Error).message),
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
      {/* 搜索框 */}
      <div style={{ padding: "8px 10px 4px", flexShrink: 0 }}>
        <Input
          size="small"
          value={keyword}
          onChange={(e) => onSearch(e.target.value)}
          prefix={<SearchOutlined style={{ color: "var(--color-text-tertiary)", fontSize: 11 }} />}
          placeholder="按文件名搜索"
          allowClear
          style={{ fontSize: 12 }}
        />
      </div>

      {/* 标题行 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "2px 10px 6px",
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
          我的资产
        </span>
        <button type="button" title="刷新" onClick={refresh} style={iconButtonStyle}>
          <ReloadOutlined style={{ fontSize: 11 }} />
        </button>
        <button
          type="button"
          title="新建文件夹"
          disabled={!workspaceId}
          onClick={() => setCreating(true)}
          style={{
            ...iconButtonStyle,
            opacity: workspaceId ? 1 : 0.3,
            cursor: workspaceId ? "pointer" : "not-allowed",
          }}
        >
          <FolderAddOutlined style={{ fontSize: 11 }} />
        </button>
      </div>

      {/* 目录树 */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 6px" }}>
        {workspaceId ? (
          loadingDirs["."] && Object.keys(dirs).length === 0 ? (
            <div style={{ padding: "8px 8px" }}>
              <Skeleton active paragraph={{ rows: 4 }} title={false} />
            </div>
          ) : filteredTreeData.length === 0 ? (
            keyword.trim() ? (
              <div
                style={{ padding: "14px 8px", fontSize: 12, color: "var(--color-text-tertiary)" }}
              >
                无匹配文件
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                    工作区暂无文件
                  </span>
                }
                style={{ marginTop: 24 }}
              />
            )
          ) : (
            <Tree
              treeData={filteredTreeData}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys as string[])}
              selectedKeys={selectedFilePath ? [selectedFilePath] : []}
              onSelect={(keys) => {
                const path = keys[0] as string | undefined;
                if (path) setSelectedFilePath(path);
              }}
              loadData={(node) => loadDir(node.key as string)}
              showIcon
              blockNode
              style={{ background: "transparent", fontSize: 12.5 }}
            />
          )
        ) : (
          <div style={{ padding: 16, fontSize: 12, color: "var(--color-text-tertiary)" }}>
            请先选择工作区
          </div>
        )}
      </div>

      {/* 新建文件夹 Modal */}
      <Modal
        open={creating}
        title="新建文件夹"
        width={420}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        onOk={() => {
          if (!newName.trim()) {
            antdMessage.warning("请输入文件夹名称");
            return;
          }
          createMutation.mutate();
        }}
        onCancel={() => {
          setCreating(false);
          setNewName("");
        }}
        destroyOnClose
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
              文件夹名称
            </div>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="如需在子目录内创建，如 短剧A"
              onPressEnter={() => {
                if (newName.trim()) createMutation.mutate();
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
            创建后将自动生成四个资产子目录：
            <span style={{ margin: "0 2px" }}>{ASSET_DIRS.join(" / ")}</span>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function buildNodes(dirPath: string, dirs: Record<string, FileEntry[]>): TreeNode[] {
  const entries = dirs[dirPath] ?? [];
  return entries.map((entry) => {
    const node: TreeNode = {
      key: entry.path,
      title: entry.name,
      isLeaf: entry.type === "file",
      icon: entry.type === "directory" ? <FolderOutlined /> : <FileTextOutlined />,
    };
    if (entry.type === "directory" && dirs[entry.path]) {
      node.children = buildNodes(entry.path, dirs);
    }
    return node;
  });
}

/** 按文件名过滤（保留匹配节点及其祖先目录链） */
function filterTree(nodes: TreeNode[], keyword: string): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const nameMatch = node.title.toLowerCase().includes(keyword);
    const children = node.children ? filterTree(node.children, keyword) : undefined;
    if (nameMatch || (children && children.length > 0)) {
      result.push({ ...node, children });
    }
  }
  return result;
}

/** 收集含有匹配项的目录 key（用于搜索时自动展开） */
function collectDirKeys(nodes: TreeNode[], keyword: string, keys: string[]): void {
  for (const node of nodes) {
    if (node.isLeaf) continue;
    const hasMatch =
      node.title.toLowerCase().includes(keyword) || collectContains(node.children, keyword);
    if (hasMatch) keys.push(node.key);
    if (node.children) collectDirKeys(node.children, keyword, keys);
  }
}

function collectContains(nodes: TreeNode[] | undefined, keyword: string): boolean {
  if (!nodes) return false;
  return nodes.some(
    (n) => n.title.toLowerCase().includes(keyword) || collectContains(n.children, keyword),
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  borderRadius: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-text-tertiary)",
  cursor: "pointer",
  flexShrink: 0,
};
