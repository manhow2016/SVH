import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Tree, Tooltip, message as antdMessage } from "antd";
import type { DataNode } from "antd/es/tree";
import {
  AppstoreOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FolderAddOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { assetsApi } from "../../api/assets";

/** 全局资产库的四个资源类型 */
const ASSET_TYPES = ["角色", "场景", "道具", "音色"] as const;
/** 系统保护文件夹：不可重命名/删除 */
const PROTECTED_ASSET = "默认";

export interface AssetsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 全局资产库弹窗：以文件夹组织角色 / 场景 / 道具 / 音色四类资源。
 * 支持新建（自动生成四类子目录）、重命名、删除（带警告确认）。
 */
export function AssetsModal({ open, onClose }: AssetsModalProps) {
  const queryClient = useQueryClient();
  const { data: assets } = useQuery({
    queryKey: ["assets"],
    queryFn: () => assetsApi.list(),
    enabled: open,
  });

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; name: string; value: string } | null>(
    null,
  );

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["assets"] });

  const createMutation = useMutation({
    mutationFn: () => assetsApi.create(newName.trim()),
    onSuccess: (result) => {
      antdMessage.success(`已创建资源文件夹「${result.path}」`);
      setCreating(false);
      setNewName("");
      invalidate();
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { name: string; newName: string }) => assetsApi.rename(input.name, input.newName),
    onSuccess: (result) => {
      antdMessage.success(`已重命名为「${result.path}」`);
      setRenaming(null);
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

  const treeData = useMemo<DataNode[]>(
    () =>
      (assets ?? []).map((folder) => ({
        key: folder.path,
        isLeaf: false,
        title: (
          <AssetFolderTitle
            name={folder.name}
            isProtected={folder.name === PROTECTED_ASSET}
            onRename={() =>
              setRenaming({ path: folder.path, name: folder.name, value: folder.name })
            }
            onDelete={() => confirmDelete(folder.name)}
          />
        ),
        children: ASSET_TYPES.map((type) => ({
          key: `${folder.path}/${type}`,
          isLeaf: true,
          title: (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <FolderOutlined style={{ color: "var(--color-text-tertiary)", fontSize: 12 }} />
              {type}
            </span>
          ),
        })),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assets],
  );

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
        width={560}
        footer={null}
        destroyOnClose
      >
        {/* 顶部：新建资源文件夹 */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
            每个资源文件夹包含「{ASSET_TYPES.join(" / ")}」四个类型
          </div>
          <span style={{ flex: 1 }} />
          <Button
            size="small"
            icon={<FolderAddOutlined />}
            onClick={() => {
              setNewName("");
              setCreating(true);
            }}
          >
            新建文件夹
          </Button>
        </div>

        {/* 资产文件夹树 */}
        <div style={{ maxHeight: "60vh", overflow: "auto" }}>
          {assets && assets.length > 0 ? (
            <Tree
              treeData={treeData}
              defaultExpandAll
              showIcon={false}
              blockNode
              selectable={false}
              style={{ background: "transparent", fontSize: 12.5 }}
            />
          ) : (
            <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-tertiary)" }}>
              暂无资源文件夹，点击右上「新建文件夹」创建
            </div>
          )}
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
        destroyOnClose
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="如：古装短剧"
          onPressEnter={() => {
            if (newName.trim()) createMutation.mutate();
          }}
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
        destroyOnClose
      >
        <Input
          value={renaming?.value ?? ""}
          onChange={(e) => setRenaming((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
          onPressEnter={() => {
            if (renaming?.value.trim())
              renameMutation.mutate({ name: renaming.name, newName: renaming.value.trim() });
          }}
        />
      </Modal>
    </>
  );
}

/** 文件夹节点标题：名称 + 重命名/删除操作（受保护文件夹隐藏操作） */
function AssetFolderTitle({
  name,
  isProtected,
  onRename,
  onDelete,
}: {
  name: string;
  isProtected: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        width: "100%",
        paddingRight: 4,
      }}
    >
      <FolderOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
        {isProtected && (
          <span style={{ marginLeft: 6, fontSize: 11, color: "var(--color-text-tertiary)" }}>
            （系统）
          </span>
        )}
      </span>
      {isProtected ? (
        <Tooltip title="系统文件夹不可修改">
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "0 4px" }}>
            受保护
          </span>
        </Tooltip>
      ) : (
        <>
          <Tooltip title="重命名">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
              style={iconBtnStyle}
            >
              <EditOutlined style={{ fontSize: 11 }} />            </button>
          </Tooltip>
          <Tooltip title="删除">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              style={iconBtnStyle}
            >
              <DeleteOutlined style={{ fontSize: 11 }} />
            </button>
          </Tooltip>
        </>
      )}
    </span>
  );
}

const iconBtnStyle: React.CSSProperties = {
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
  flexShrink: 0,
};
