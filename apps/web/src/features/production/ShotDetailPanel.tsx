/**
 * 镜头详情面板（V0.3 §37-§39）。
 *
 * 展示单个镜头的：规格信息、生成版本（v1/v2/…，含状态/审核/提示词/产出资产预览）、
 * 审核动作（Approve / Reject / Replace）、Prompt Inspector（最终 Prompt + 来源元数据）。
 * 数据：镜头（listShots 命中）+ 生成记录（listByShot）+ 项目资产（解析产出/替换候选）。
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Skeleton, Space, Tag, Typography, message } from "antd";
import { CheckOutlined, DeleteOutlined, EditOutlined, ReloadOutlined, SwapOutlined } from "@ant-design/icons";
import { assetLocalSrc, generationApi, productionApi } from "../../api/production";
import {
  GENERATION_RECORD_STATUS_LABELS,
  GENERATION_REVIEW_STATUS_LABELS,
  type GenerationRecord,
  type ProductionAsset,
  type ProductionShot,
} from "../../types/production-types";

const { Text } = Typography;

interface ShotDetailPanelProps {
  projectId: string;
  shotId: string;
  open: boolean;
  onClose: () => void;
}

function printMetadata(record: GenerationRecord): string[] {
  const meta = record.promptMetadata ?? {};
  const parts: string[] = [];
  if (record.providerId) parts.push(`供应商：${record.providerId}`);
  if (record.modelId) parts.push(`模型：${record.modelId}`);
  if (typeof meta.templateId === "string") parts.push(`模板：${meta.templateId}`);
  if (record.taskId) parts.push(`任务：${record.taskId}`);
  return parts;
}

function ShotPanel({ projectId, shotId, onClose }: Omit<ShotDetailPanelProps, "open">) {
  const queryClient = useQueryClient();
  const [replaceTarget, setReplaceTarget] = useState<string | undefined>();
  const [busy, setBusy] = useState<"approve" | "reject" | "replace" | "regenerate" | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [promptEditOpen, setPromptEditOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [promptForm] = Form.useForm();

  const openEdit = () => {
    if (!shotResolved) return;
    // 用当前列表中命中的镜头数据预填弹窗（避免单独 GET）
    editForm.setFieldsValue({
      duration: shotResolved.duration,
      framing: shotResolved.framing,
      cameraMovement: shotResolved.cameraMovement,
      action: shotResolved.action,
      dialogue: shotResolved.dialogue,
    });
    setEditOpen(true);
  };

  const { data: shots, isLoading: shotsLoading } = useQuery({
    queryKey: ["production-shots", projectId],
    queryFn: () => productionApi.listShots(projectId),
  });
  const { data: shot } = useQuery({
    queryKey: ["production-shot", projectId, shotId],
    queryFn: async () => {
      const all = await productionApi.listShots(projectId);
      return all.find((s) => s.id === shotId) ?? null;
    },
    initialData: undefined,
  });
  const { data: records, isLoading, error } = useQuery({
    queryKey: ["generation-records", projectId, shotId],
    queryFn: () => generationApi.listByShot(shotId),
  });
  const { data: assets } = useQuery({
    queryKey: ["production-assets", projectId],
    queryFn: () => productionApi.listAssets(projectId),
  });

  const assetById = useMemo(() => {
    const map = new Map<string, ProductionAsset>();
    for (const a of assets ?? []) map.set(a.id, a);
    return map;
  }, [assets]);

  const sorted = useMemo(() => [...(records ?? [])].sort((a, b) => b.version - a.version), [records]);
  const selected = sorted.find((r) => r.selected) ?? sorted[0];
  const shotResolved: ProductionShot | null =
    shot !== undefined ? shot : (shots?.find((s) => s.id === shotId) ?? null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["generation-records", projectId, shotId] });
    await queryClient.invalidateQueries({ queryKey: ["production-shot", projectId, shotId] });
    await queryClient.invalidateQueries({ queryKey: ["production-shots", projectId] });
  };

  const act = async (
    kind: "approve" | "reject" | "replace" | "regenerate",
    record: GenerationRecord,
    regen?: { prompt?: string; negativePrompt?: string },
  ) => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === "approve") await generationApi.approve(record.id);
      else if (kind === "reject") await generationApi.reject(record.id);
      else if (kind === "replace") {
        if (!replaceTarget) throw new Error("请先选择要替换的资产");
        await generationApi.replace(record.id, replaceTarget);
      } else if (kind === "regenerate") {
        // 支持先编辑 Prompt 再重新生成（未提供覆盖时沿用当前最终 Prompt）
        await generationApi.regenerate(record.id, {
          prompt: regen?.prompt ?? record.prompt,
          negativePrompt: regen?.negativePrompt ?? record.negativePrompt,
        });
      }
      message.success(
        kind === "approve"
          ? "已通过，并设为该镜头当前选中资产"
          : kind === "reject"
            ? "已拒绝"
            : kind === "replace"
              ? "已替换"
              : "已创建新版本（v+1）并入队生成",
      );
      await refresh();
      setReplaceTarget(undefined);
    } catch (err) {
      message.error(`操作失败：${(err as Error)?.message ?? "未知错误"}`);
    } finally {
      setBusy(null);
    }
  };

  const renderAssetPreview = (record: GenerationRecord) => {
    const asset = record.outputAssetId ? assetById.get(record.outputAssetId) : undefined;
    if (!asset || (!asset.url && !asset.workspacePath)) {
      return <Text type="secondary">（无产出资产）</Text>;
    }
    const src = assetLocalSrc(asset) || asset.url;
    return (
      <div style={{ marginTop: 8 }}>
        {asset.type === "image" ? (
          <img src={src} alt={asset.name} style={{ width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 6, background: "var(--color-surface-secondary)" }} />
        ) : (
          <video src={src} controls style={{ width: "100%", maxHeight: 220, borderRadius: 6, background: "#000" }} />
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {shotsLoading ? <Skeleton active paragraph={{ rows: 3 }} /> : null}

      {/* 镜头规格 */}
      {shotResolved && (
        <section style={{ borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface)", padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>镜头规格</span>
            <div style={{ flex: 1 }} />
            <Button size="small" type="text" icon={<EditOutlined />} onClick={openEdit}>
              编辑
            </Button>
            <Popconfirm
              title="删除该镜头？"
              description="删除后其生成记录与版本不再展示，操作不可恢复。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                await productionApi.deleteShot(shotId);
                await queryClient.invalidateQueries({ queryKey: ["production-shots", projectId] });
                onClose();
              }}
            >
              <Button size="small" type="text" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 13, color: "var(--color-text-secondary)" }}>
            <span>时长：{shotResolved.duration}s</span>
            {shotResolved.framing && <span>景别：{shotResolved.framing}</span>}
            {shotResolved.cameraMovement && <span>运镜：{shotResolved.cameraMovement}</span>}
            {shotResolved.action && <span>动作：{shotResolved.action}</span>}
            {shotResolved.dialogue && <span>对白：{shotResolved.dialogue}</span>}
          </div>
        </section>
      )}

      {/* 生成版本 */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>生成版本</span>
          <Tag style={{ marginInlineEnd: 0 }}>{sorted.length} 版</Tag>
        </div>
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : error ? (
          <Alert type="error" message="生成记录加载失败" description={(error as Error)?.message} />
        ) : !sorted || sorted.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
                暂无生成记录，可在「资产」面板生成，或使用批量生成。
              </div>
            }
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sorted.map((record) => {
              const review = GENERATION_REVIEW_STATUS_LABELS[record.reviewStatus];
              const statusText = GENERATION_RECORD_STATUS_LABELS[record.status];
              const reviewable = record.status === "completed" && Boolean(record.outputAssetId);
              const isSelected = record.selected;
              return (
                <div
                  key={record.id}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--color-border)",
                    background: isSelected ? "#eef7f2" : "var(--color-surface)",
                    padding: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
                      v{record.version}
                    </span>
                    <Tag style={{ marginInlineEnd: 0 }} color={review.color}>
                      {review.text}
                    </Tag>
                    <Tag style={{ marginInlineEnd: 0 }} color="default">
                      {statusText}
                    </Tag>
                    <Tag style={{ marginInlineEnd: 0 }} color="default">
                      {record.kind === "image" ? "图片" : "视频"}
                    </Tag>
                    {isSelected && (
                      <Tag style={{ marginInlineEnd: 0 }} color="#2e9e62">
                        当前选中
                      </Tag>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-tertiary)" }}>
                      {new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                    <Text style={{ display: "block", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                      {record.prompt || "（无提示词）"}
                    </Text>
                  </div>

                  <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
                    {printMetadata(record).join(" · ")}
                  </div>

                  {renderAssetPreview(record)}

                  {reviewable && (
                    <Space style={{ marginTop: 4 }} wrap>
                      <Button
                        size="small"
                        type="primary"
                        icon={<CheckOutlined />}
                        loading={busy === "approve"}
                        disabled={busy !== null || record.reviewStatus === "approved"}
                        onClick={() => void act("approve", record)}
                      >
                        通过
                      </Button>
                      <Button
                        size="small"
                        danger
                        loading={busy === "reject"}
                        disabled={busy !== null || record.reviewStatus === "rejected"}
                        onClick={() => void act("reject", record)}
                      >
                        拒绝
                      </Button>
                      <Button
                        size="small"
                        icon={<SwapOutlined />}
                        loading={busy === "replace"}
                        disabled={busy !== null}
                        onClick={() => void act("replace", record)}
                      >
                        替换
                      </Button>
                      {busy === "replace" && (
                        <Select
                          size="small"
                          placeholder="选择替换资产"
                          value={replaceTarget}
                          style={{ minWidth: 180 }}
                          onChange={setReplaceTarget}
                          options={(assets ?? [])
                            .filter((a) => a.type === (record.kind === "image" ? "image" : "video"))
                            .map((a) => ({ value: a.id, label: a.name }))}
                        />
                      )}
                    </Space>
                  )}
                  <Button
                    size="small"
                    type="text"
                    icon={<ReloadOutlined />}
                    loading={busy === "regenerate"}
                    disabled={busy !== null}
                    onClick={() => void act("regenerate", record)}
                  >
                    重新生成（v{record.version + 1}）
                  </Button>
                  {record.error && <Alert type="error" showIcon message={`生成失败：${record.error}`} />}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Prompt Inspector */}
      {selected && (
        <section style={{ borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface)", padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>
              Prompt Inspector
            </span>
            <div style={{ flex: 1 }} />
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              disabled={busy !== null}
              onClick={() => {
                promptForm.setFieldsValue({
                  prompt: selected.prompt,
                  negativePrompt: selected.negativePrompt ?? "",
                });
                setPromptEditOpen(true);
              }}
            >
              编辑并重新生成
            </Button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 4 }}>
                最终 Prompt（v{selected.version} · {selected.kind === "image" ? "图片" : "视频"}）
              </div>
              <pre style={{ margin: 0, padding: 10, borderRadius: 6, background: "var(--color-surface-secondary)", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {selected.prompt || "（空）"}
              </pre>
            </div>
            {selected.negativePrompt && (
              <div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 4 }}>Negative Prompt</div>
                <pre style={{ margin: 0, padding: 10, borderRadius: 6, background: "var(--color-surface-secondary)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {selected.negativePrompt}
                </pre>
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{printMetadata(selected).join(" · ")}</div>
          </div>
        </section>
      )}

      {/* 编辑镜头规格 */}
      <Modal
        open={editOpen}
        title="编辑镜头规格"
        width={480}
        okText="保存"
        cancelText="取消"
        onOk={async () => {
          const values = await editForm.validateFields();
          await productionApi.updateShot(shotId, {
            duration: values.duration,
            framing: values.framing,
            cameraMovement: values.cameraMovement,
            action: values.action,
            dialogue: values.dialogue,
          });
          setEditOpen(false);
          await queryClient.invalidateQueries({ queryKey: ["production-shots", projectId] });
        }}
        onCancel={() => setEditOpen(false)}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="时长（秒）" name="duration" rules={[{ required: true, message: "请输入时长" }]}>
            <Input type="number" min={1} />
          </Form.Item>
          <Form.Item label="景别" name="framing">
            <Input placeholder="如 medium / close_up" maxLength={100} />
          </Form.Item>
          <Form.Item label="运镜" name="cameraMovement">
            <Input placeholder="如 dolly / pan" maxLength={100} />
          </Form.Item>
          <Form.Item label="动作" name="action">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
          <Form.Item label="对白" name="dialogue">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑 Prompt 并重新生成（v+1）：Prompt Inspector 入口 */}
      <Modal
        open={promptEditOpen}
        title="编辑 Prompt 并重新生成"
        width={520}
        okText="重新生成（v+1）"
        cancelText="取消"
        confirmLoading={busy === "regenerate"}
        onOk={async () => {
          const values = await promptForm.validateFields();
          if (!selected) return;
          await act("regenerate", selected, {
            prompt: values.prompt,
            negativePrompt: values.negativePrompt,
          });
          setPromptEditOpen(false);
        }}
        onCancel={() => setPromptEditOpen(false)}
        destroyOnHidden
      >
        <Form form={promptForm} layout="vertical">
          <Form.Item label="最终 Prompt" name="prompt" rules={[{ required: true, message: "请输入 Prompt" }]}>
            <Input.TextArea rows={6} />
          </Form.Item>
          <Form.Item label="Negative Prompt" name="negativePrompt">
            <Input.TextArea rows={3} />
          </Form.Item>
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
            保存后将基于编辑后的 Prompt 创建 v+1 版本并入队生成（同镜头版本递增）。
          </div>
        </Form>
      </Modal>
    </div>
  );
}

export function ShotDetailPanel({ projectId, shotId, open, onClose }: ShotDetailPanelProps) {
  return (
    <Drawer
      title="镜头详情"
      width={560}
      open={open}
      onClose={onClose}
      destroyOnHidden
      extra={
        <Button size="small" icon={<ReloadOutlined />} onClick={() => onClose()}>
          关闭
        </Button>
      }
    >
      <ShotPanel projectId={projectId} shotId={shotId} onClose={onClose} />
    </Drawer>
  );
}

/** 供 StoryboardsPanel 调用的「打开镜头详情」钩子数据 */
export const GENERATION_SCOPE_HELP = "可为单镜头生成多个版本并审核，最终保留一个「当前选中资产」。";
