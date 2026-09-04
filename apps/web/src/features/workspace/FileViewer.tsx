import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Modal, Skeleton, message as antdMessage } from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  FileOutlined,
  SaveOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { fileApi } from "../../api/files";
import { MonacoEditor } from "../../components/MonacoEditor";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useUIStore } from "../../stores/ui-store";
import { languageFromPath } from "../../lib/format";

/**
 * File Viewer（文档 §40）：
 * View / Edit / Save 三态，Monaco 编辑文本文件。
 */
export function FileViewer() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { selectedFilePath, setSelectedFilePath } = useWorkspaceStore();
  const bumpFilesRevision = useUIStore((s) => s.bumpFilesRevision);
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState(false);

  const {
    data: file,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["file", workspaceId, selectedFilePath],
    queryFn: () => fileApi.read(workspaceId!, selectedFilePath!),
    enabled: !!workspaceId && !!selectedFilePath,
  });

  // 切换文件时重置编辑状态
  useEffect(() => {
    setMode("view");
    setDraft(file?.content ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilePath]);

  const saveMutation = useMutation({
    mutationFn: () => fileApi.write(workspaceId!, selectedFilePath!, draft),
    onSuccess: () => {
      antdMessage.success("已保存");
      setMode("view");
      void queryClient.invalidateQueries({ queryKey: ["file", workspaceId, selectedFilePath] });
      bumpFilesRevision();
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => fileApi.remove(workspaceId!, selectedFilePath!),
    onSuccess: () => {
      antdMessage.success("已删除");
      setDeleting(false);
      setSelectedFilePath(null);
      bumpFilesRevision();
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  if (!selectedFilePath) {
    return (
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
        <FileOutlined style={{ fontSize: 26 }} />
        <div style={{ fontSize: 13 }}>未选择文件</div>
        <div style={{ fontSize: 12 }}>在左侧文件树中选择一个文件查看或编辑</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ padding: 16 }}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (error || !file) {
    return (
      <div style={{ padding: 16 }}>
        <Alert
          type="error"
          showIcon
          message="文件读取失败"
          description={(error as Error)?.message ?? "文件不存在"}
        />
      </div>
    );
  }

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
      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 36,
          padding: "0 12px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <code
          style={{
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: 12.5,
            color: "var(--color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.path}
        </code>
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          type={mode === "view" ? "primary" : "text"}
          icon={<EyeOutlined />}
          onClick={() => {
            setDraft(file.content);
            setMode("view");
          }}
        >
          查看
        </Button>
        <Button
          size="small"
          type={mode === "edit" ? "primary" : "text"}
          icon={<EditOutlined />}
          onClick={() => setMode("edit")}
        >
          编辑
        </Button>
        {mode === "edit" && (
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            loading={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            保存
          </Button>
        )}
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setDeleting(true)}>
          删除
        </Button>
      </div>

      {/* 编辑器 */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <MonacoEditor
          value={mode === "edit" ? draft : file.content}
          language={languageFromPath(file.path)}
          readOnly={mode === "view"}
          onChange={(value) => setDraft(value)}
        />
      </div>

      {/* 删除确认 */}
      <Modal
        open={deleting}
        title="删除文件"
        width={380}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={deleteMutation.isPending}
        onOk={() => deleteMutation.mutate()}
        onCancel={() => setDeleting(false)}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          确定删除文件 <b>{file.path}</b> 吗？此操作不可恢复。
        </div>
      </Modal>
    </div>
  );
}
