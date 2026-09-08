/**
 * 待审核面板（Phase D）：项目内「已完成但未裁定」的生成记录按分镜分组展示，
 * 支持逐条 通过/拒绝 与按分镜一键「全部通过」——无需逐镜头点进详情 Drawer。
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Popconfirm, Skeleton, Tag } from "antd";
import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { assetLocalSrc, generationApi, productionApi } from "../../api/production";
import type { GenerationRecord, ProductionAsset, ProductionShot, Storyboard } from "../../types/production-types";

export interface ReviewQueuePanelProps {
  projectId: string;
}

/** 未裁定的审核状态集合 */
const UNRESOLVED = new Set(["pending", "generating", "generated", "reviewing"]);

const KIND_LABELS: Record<string, string> = { image: "图片", video: "视频", audio: "音频" };

function RecordPreview({ record, assetById }: { record: GenerationRecord; assetById: Map<string, ProductionAsset> }) {
  const asset = record.outputAssetId ? assetById.get(record.outputAssetId) : undefined;
  const src = asset ? assetLocalSrc(asset) || asset.url : undefined;
  if (record.kind === "image" && src) {
    return (
      <img src={src} alt={asset?.name ?? "图片"} style={{ width: 96, height: 64, objectFit: "cover", borderRadius: 6, background: "var(--color-surface-secondary)" }} />
    );
  }
  if (record.kind === "video" && src) {
    return <video src={src} style={{ width: 96, height: 64, objectFit: "cover", borderRadius: 6, background: "#000" }} />;
  }
  if (record.kind === "audio" && src) {
    return <audio controls src={src} style={{ height: 32, maxWidth: 160 }} />;
  }
  return (
    <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
      {KIND_LABELS[record.kind] ?? record.kind} · v{record.version}
    </span>
  );
}

export function ReviewQueuePanel({ projectId }: ReviewQueuePanelProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data: records, isLoading, error } = useQuery({
    queryKey: ["generation-records", projectId],
    queryFn: () => generationApi.listByProject(projectId),
  });
  const { data: storyboards } = useQuery({
    queryKey: ["production-storyboards", projectId],
    queryFn: () => productionApi.listStoryboards(projectId),
  });
  const { data: shots } = useQuery({
    queryKey: ["production-shots", projectId],
    queryFn: () => productionApi.listShots(projectId),
  });
  const { data: assets } = useQuery({
    queryKey: ["production-assets", projectId],
    queryFn: () => productionApi.listAssets(projectId),
  });

  const assetById = useMemo(() => {
    const map = new Map<string, ProductionAsset>();
    for (const asset of assets ?? []) map.set(asset.id, asset);
    return map;
  }, [assets]);

  const shotById = useMemo(() => {
    const map = new Map<string, ProductionShot>();
    for (const shot of shots ?? []) map.set(shot.id, shot);
    return map;
  }, [shots]);

  const sbById = useMemo(() => {
    const map = new Map<string, Storyboard>();
    for (const sb of storyboards ?? []) map.set(sb.id, sb);
    return map;
  }, [storyboards]);

  /** 未裁定记录（已完成才可审核；未完成的待生成记录不在此展示） */
  const pending = useMemo(
    () =>
      (records ?? [])
        .filter((r) => r.status === "completed" && UNRESOLVED.has(r.reviewStatus))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [records],
  );

  /** 按分镜分组（无分镜的分到「未分组」） */
  const groups = useMemo(() => {
    const map = new Map<string, GenerationRecord[]>();
    for (const record of pending) {
      const shot = record.shotId ? shotById.get(record.shotId) : undefined;
      const sbId = record.storyboardId ?? shot?.storyboardId ?? "__none__";
      const list = map.get(sbId) ?? [];
      list.push(record);
      map.set(sbId, list);
    }
    return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }, [pending, shotById]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["generation-records", projectId] });
  };

  const reviewOne = async (record: GenerationRecord, action: "approve" | "reject") => {
    setBusy(record.id);
    try {
      if (action === "approve") await generationApi.approve(record.id);
      else await generationApi.reject(record.id);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const reviewGroup = async (sbId: string, action: "approve" | "reject") => {
    setBusy(`group-${sbId}`);
    try {
      await generationApi.batchReview(projectId, {
        scope: sbId === "__none__" ? undefined : { storyboardId: sbId },
        action,
      });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (error) return <Alert type="error" message="待审核加载失败" description={(error as Error)?.message} />;

  if (pending.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
              没有待审核的生成
            </span>
            <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", maxWidth: 320 }}>
              在工作流「分镜 / 资产」生成图片、视频或配音并完成后，将在这里集中审核。
            </span>
          </div>
        }
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
        共 {pending.length} 条待审核 · 通过/拒绝后，等待中的工作流将自动继续
      </div>

      {groups.map(([sbId, list]) => {
        const sb = sbById.get(sbId);
        const groupTitle = sb ? `分镜 ${sb.order + 1} · ${sb.description.slice(0, 30)}` : "未分组";
        return (
          <section
            key={sbId}
            style={{
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              padding: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
                {groupTitle}
              </span>
              <Tag style={{ marginInlineEnd: 0 }}>{list.length} 条</Tag>
              <div style={{ flex: 1 }} />
              <Button
                size="small"
                type="primary"
                ghost
                icon={<CheckOutlined />}
                loading={busy === `group-${sbId}`}
                onClick={() => void reviewGroup(sbId, "approve")}
              >
                全部通过
              </Button>
              <Button
                size="small"
                danger
                ghost
                icon={<CloseOutlined />}
                loading={busy === `group-${sbId}`}
                onClick={() => void reviewGroup(sbId, "reject")}
              >
                全部拒绝
              </Button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((record) => {
                const shot = record.shotId ? shotById.get(record.shotId) : undefined;
                return (
                  <div
                    key={record.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--color-border)",
                      background: "var(--color-surface-secondary)",
                      flexWrap: "wrap",
                    }}
                  >
                    <RecordPreview record={record} assetById={assetById} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 150, flex: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)" }}>
                        {KIND_LABELS[record.kind] ?? record.kind} · v{record.version}
                        {shot ? ` · #${shot.order + 1} 镜头` : ""}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--color-text-tertiary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 320,
                        }}
                      >
                        {record.prompt}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Button
                        size="small"
                        type="primary"
                        icon={<CheckOutlined />}
                        loading={busy === record.id}
                        onClick={() => void reviewOne(record, "approve")}
                      >
                        通过
                      </Button>
                      <Popconfirm
                        title="确认拒绝该版本？"
                        okText="拒绝"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void reviewOne(record, "reject")}
                      >
                        <Button size="small" danger icon={<CloseOutlined />} loading={busy === record.id}>
                          拒绝
                        </Button>
                      </Popconfirm>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
