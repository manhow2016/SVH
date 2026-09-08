import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Modal, Tabs, Tooltip, message as antdMessage } from "antd";
import {
  AppstoreOutlined,
  AudioOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOutlined,
  GiftOutlined,
  PictureOutlined,
  ReloadOutlined,
  UploadOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { assetsApi } from "../../api/assets";
import type { FileEntry } from "../../types/api-types";

/** 全局资产库的四个资源类型 */
const ASSET_TYPES = ["角色", "场景", "道具", "音色"] as const;
/** 资产类型图标（菜单 / Tab 展示） */
const ASSET_TYPE_ICONS: Record<string, ReactNode> = {
  角色: <UserOutlined />,
  场景: <PictureOutlined />,
  道具: <GiftOutlined />,
  音色: <AudioOutlined />,
};
/** 系统保护文件夹：不可重命名/删除 */
const PROTECTED_ASSET = "默认";

export interface AssetsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 全局资产库弹窗（大窗口）：
 * 左侧管理资源文件夹（新建/重命名/删除），右侧按类型 Tab + 列表展示资产内容。
 */
export function AssetsModal({ open, onClose }: AssetsModalProps) {
  const queryClient = useQueryClient();
  const { data: folders } = useQuery({
    queryKey: ["assets"],
    queryFn: () => assetsApi.list(),
    enabled: open,
  });

  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<string>(ASSET_TYPES[0]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);

  // 文件夹列表变化：默认选中第一个；选中项不存在时回退
  useEffect(() => {
    if (!folders || folders.length === 0) {
      setSelectedFolder(null);
      return;
    }
    if (!selectedFolder || !folders.some((f) => f.name === selectedFolder)) {
      setSelectedFolder(folders[0]!.name);
    }
  }, [folders, selectedFolder]);

  // 选中文件夹/类型变化时刷新内容
  const { data: content, isLoading: contentLoading } = useQuery({
    queryKey: ["assets-content", selectedFolder, activeType],
    queryFn: () =>
      selectedFolder ? assetsApi.list(`${selectedFolder}/${activeType}`) : Promise.resolve([]),
    enabled: open && !!selectedFolder,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
    void queryClient.invalidateQueries({ queryKey: ["assets-content"] });
  };

  const createMutation = useMutation({
    mutationFn: () => assetsApi.create(newName.trim()),
    onSuccess: (result) => {
      antdMessage.success(`已创建资源文件夹「${result.path}」`);
      setCreating(false);
      setNewName("");
      setSelectedFolder(result.path);
      invalidate();
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { name: string; newName: string }) =>
      assetsApi.rename(input.name, input.newName),
    onSuccess: (result) => {
      antdMessage.success(`已重命名为「${result.path}」`);
      setRenaming(null);
      setSelectedFolder(result.path);
      invalidate();
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => assetsApi.remove(name),
    onSuccess: (result) => {
      antdMessage.success(`已删除「${result.path}」`);
      invalidate();
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const uploadMutation = useMutation({
    mutationFn: (input: { path: string; content: string }) =>
      assetsApi.upload(input.path, input.content),
    onSuccess: (result) => {
      antdMessage.success(`已上传「${result.path}」`);
      invalidate();
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  /** 上传文本类资产：选择类型后打开文件选择器 */
  const pickUploadFile = (type: string) => {
    if (!selectedFolder) {
      antdMessage.warning("请先选择资源文件夹");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.txt,.json,.yaml,.yml,.csv,.js,.ts,.py,.html,.css";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const content = await file.text();
        uploadMutation.mutate({ path: `${selectedFolder}/${type}/${file.name}`, content });
      } catch (err) {
        antdMessage.error(`读取文件失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    input.click();
  };

  /** 删除文件夹：警告确认（四个分类内容将被递归删除且不可恢复） */
  const confirmDelete = (name: string) => {
    Modal.confirm({
      title: "删除资源文件夹",
      icon: <ExclamationCircleOutlined style={{ color: "var(--color-error)" }} />,
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          确定删除资源文件夹 <b>{name}</b> 吗？
          <br />
          {ASSET_TYPES.join(" / ")} 分类中的全部内容将一并删除，此操作不可恢复。
        </div>
      ),
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => deleteMutation.mutateAsync(name),
    });
  };

  const folderList = useMemo(() => folders ?? [], [folders]);

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <AppstoreOutlined style={{ color: "var(--color-primary)" }} />
            我的资产
          </span>
        }
        width={1040}
        style={{ top: 40 }}
        footer={null}
        destroyOnHidden
      >
        <div className="assets-modal-body" style={{ display: "flex", gap: 12, height: 620, minHeight: 0 }}>
          {/* ===== 左栏：文件夹管理（移动端折叠为顶部面板，见 index.css） ===== */}
          <div
            className="assets-folder-pane"
            style={{
              width: 280,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              borderRight: "1px solid var(--color-border)",
              paddingRight: 12,
              minHeight: 0,
            }}
          >
            {/* 左栏顶部：标题 + 新建 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-tertiary)" }}>
                资源文件夹
              </span>
              <Button
                size="small"
                icon={<FolderAddOutlined />}
                onClick={() => {
                  setNewName("");
                  setCreating(true);
                }}
              >
                新建
              </Button>
            </div>

            {/* 文件夹列表 */}
            <div className="assets-folder-list" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
              {folderList.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--color-text-tertiary)" }}>
                  暂无资源文件夹
                </div>
              ) : (
                folderList.map((folder) => (
                  <FolderRow
                    key={folder.path}
                    folder={folder}
                    active={folder.name === selectedFolder}
                    onSelect={() => setSelectedFolder(folder.name)}
                    onRename={() => setRenaming({ name: folder.name, value: folder.name })}
                    onDelete={() => confirmDelete(folder.name)}
                  />
                ))
              )}
            </div>

            <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-tertiary)" }}>
              每个文件夹包含「{ASSET_TYPES.join(" / ")}」四类资源
            </div>
          </div>

          {/* ===== 右栏：类型 Tab + 资产内容 ===== */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* 头部：当前文件夹 + 上传 + 刷新 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <FolderOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedFolder ?? "未选择"}
              </span>
              <span style={{ flex: 1 }} />
              <Dropdown
                disabled={!selectedFolder}
                menu={{
                  items: ASSET_TYPES.map((t) => ({
                    key: t,
                    label: <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{ASSET_TYPE_ICONS[t]}{t}</span>,
                  })),
                  onClick: ({ key }) => pickUploadFile(key),
                }}
              >
                <Button size="small" icon={<UploadOutlined />} disabled={!selectedFolder}>
                  上传
                </Button>
              </Dropdown>
              <Tooltip title="刷新">
                <Button
                  size="small"
                  type="text"
                  icon={<ReloadOutlined />}
                  onClick={() => invalidate()}
                />
              </Tooltip>
            </div>

            <Tabs
              activeKey={activeType}
              onChange={setActiveType}
              items={ASSET_TYPES.map((t) => ({ key: t, label: t }))}
              size="small"
              style={{ marginBottom: 0 }}
            />

            {/* 资产内容列表 */}
            <div style={{ flex: 1, overflow: "auto", minHeight: 0, borderTop: "1px solid var(--color-border)", paddingTop: 8 }}>
              {contentLoading ? (
                <div style={{ padding: 16, color: "var(--color-text-tertiary)" }}>加载中…</div>
              ) : !content || content.length === 0 ? (
                <div
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "var(--color-text-tertiary)",
                    fontSize: 12,
                  }}
                >
                  「{activeType}」分类下暂无资产
                </div>
              ) : (
                content.map((entry) => (
                  <div
                    key={entry.path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      height: 32,
                      padding: "0 8px",
                      borderRadius: 6,
                      fontSize: 12.5,
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {entry.type === "directory" ? (
                      <FolderOutlined style={{ color: "var(--color-text-secondary)", fontSize: 12 }} />
                    ) : (
                      <FileTextOutlined style={{ color: "var(--color-text-tertiary)", fontSize: 12 }} />
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.name}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* 新建文件夹 */}
      <Modal
        open={creating}
        title="新建资源文件夹"
        width={400}
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
        onCancel={() => setCreating(false)}
        destroyOnHidden
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="如：古装短剧"
          onPressEnter={() => {
            if (newName.trim()) createMutation.mutate();
          }}
          autoFocus
        />
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-tertiary)" }}>
          创建后将自动生成四个类型子目录：{ASSET_TYPES.join(" / ")}
        </div>
      </Modal>

      {/* 重命名文件夹 */}
      <Modal
        open={!!renaming}
        title="重命名资源文件夹"
        width={400}
        okText="保存"
        cancelText="取消"
        confirmLoading={renameMutation.isPending}
        onOk={() => {
          if (!renaming?.value.trim()) {
            antdMessage.warning("请输入新名称");
            return;
          }
          renameMutation.mutate({ name: renaming.name, newName: renaming.value.trim() });
        }}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          value={renaming?.value ?? ""}
          onChange={(e) => setRenaming((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
          onPressEnter={() => {
            if (renaming?.value.trim())
              renameMutation.mutate({ name: renaming.name, newName: renaming.value.trim() });
          }}
          autoFocus
        />
      </Modal>
    </>
  );
}

/** 文件夹列表行：选中高亮；悬停显示重命名/删除（受保护文件夹隐藏操作） */
function FolderRow({
  folder,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  folder: FileEntry;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const isProtected = folder.name === PROTECTED_ASSET;
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 34,
        padding: "0 8px",
        borderRadius: 6,
        fontSize: 12.5,
        cursor: "pointer",
        color: active ? "var(--color-primary)" : "var(--color-text-primary)",
        background: active ? "var(--color-primary-bg, #e6f4ff)" : "transparent",
        fontWeight: active ? 600 : 400,
        marginBottom: 2,
      }}
    >
      <FolderOutlined style={{ fontSize: 13, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {folder.name}
      </span>
      {isProtected ? (
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", flexShrink: 0 }}>受保护</span>
      ) : (
        <span style={{ display: "inline-flex", gap: 2, flexShrink: 0 }}>
          <Tooltip title="重命名">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
              style={rowIconStyle}
            >
              <EditOutlined style={{ fontSize: 11 }} />
            </button>
          </Tooltip>
          <Tooltip title="删除">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              style={rowIconStyle}
            >
              <DeleteOutlined style={{ fontSize: 11 }} />
            </button>
          </Tooltip>
        </span>
      )}
    </div>
  );
}

const rowIconStyle: React.CSSProperties = {
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
};
