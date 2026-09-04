import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Tree, message as antdMessage } from "antd";
import {
  FileAddOutlined,
  FileTextOutlined,
  FolderOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { fileApi } from "../../api/files";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useUIStore } from "../../stores/ui-store";
import type { FileEntry } from "../../types/api-types";

interface TreeNode {
  key: string;
  title: string;
  isLeaf: boolean;
  icon?: React.ReactNode;
  children?: TreeNode[];
}

/**
 * Workspace Explorer（文档 §39）：
 * 目录树（懒加载）、选择文件、刷新、新建文件。
 */
export function WorkspaceExplorer() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { selectedFilePath, setSelectedFilePath } = useWorkspaceStore();
  const filesRevision = useUIStore((s) => s.filesRevision);
  const queryClient = useQueryClient();
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");

  const loadDir = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      const entries = await queryClient.fetchQuery({
        queryKey: ["files", workspaceId, path],
        queryFn: () => fileApi.list(workspaceId, path),
      });
      setDirs((prev) => ({ ...prev, [path]: entries }));
    },
    [workspaceId, queryClient],
  );

  // 切换 workspace：清空并加载根目录
  useEffect(() => {
    setDirs({});
    setExpandedKeys([]);
    setSelectedFilePath(null);
    void loadDir("");
  }, [workspaceId, loadDir, setSelectedFilePath]);

  // workspace.changed / 手动刷新：重载已展开目录
  useEffect(() => {
    if (!workspaceId) return;
    const known = Object.keys(dirs);
    if (known.length === 0) {
      void loadDir("");
    } else {
      for (const p of known) void loadDir(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesRevision, workspaceId]);

  const treeData = useMemo(() => buildNodes("", dirs), [dirs]);

  const refresh = () => {
    // 清除查询缓存后重载
    void queryClient.invalidateQueries({ queryKey: ["files", workspaceId] });
    const known = Object.keys(dirs);
    if (known.length === 0) void loadDir("");
    else for (const p of known) void loadDir(p);
  };

  const createMutation = useMutation({
    mutationFn: () => fileApi.write(workspaceId!, newName.trim(), newContent),
    onSuccess: (result) => {
      antdMessage.success(`已创建 ${result.path}`);
      setCreating(false);
      setNewName("");
      setNewContent("");
      refresh();
      setSelectedFilePath(result.path);
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
      {/* 头部 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 10px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <span
          style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)" }}
        >
          工作区文件
        </span>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          onClick={refresh}
          title="刷新"
          style={{ color: "var(--color-text-secondary)" }}
        />
        <Button
          type="text"
          size="small"
          icon={<FileAddOutlined />}
          onClick={() => setCreating(true)}
          title="新建文件"
          disabled={!workspaceId}
          style={{ color: "var(--color-text-secondary)" }}
        />
      </div>

      {/* 目录树 */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 6px" }}>
        {workspaceId ? (
          <Tree
            treeData={treeData}
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
        ) : (
          <div style={{ padding: 16, fontSize: 12, color: "var(--color-text-tertiary)" }}>
            请先选择 Workspace
          </div>
        )}
      </div>

      {/* 新建文件 Modal */}
      <Modal
        open={creating}
        title="新建文件"
        width={480}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        onOk={() => {
          if (!newName.trim()) {
            antdMessage.warning("请输入文件名");
            return;
          }
          createMutation.mutate();
        }}
        onCancel={() => {
          setCreating(false);
          setNewName("");
          setNewContent("");
        }}
        destroyOnClose
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
              文件名（支持子目录，如 assets/notes.md）
            </div>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="script.md"
              onPressEnter={() => {
                if (newName.trim()) createMutation.mutate();
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
              初始内容（可选）
            </div>
            <Input.TextArea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              autoSize={{ minRows: 4, maxRows: 12 }}
              placeholder="文件内容…"
            />
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
