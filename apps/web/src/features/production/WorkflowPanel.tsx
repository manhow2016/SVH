/**
 * 工作流面板（V0.2 文档 §19）：节点时间线 + Run/Pause/Resume/Cancel/Retry + SSE 实时状态。
 *
 * 会员门控：workflow.automation（前端 can() 展示 + 后端 requireFeature 权威校验）。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Empty, Modal, Skeleton, Tag, Tooltip } from "antd";
import {
  CaretRightOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  LoadingOutlined,
  MinusCircleFilled,
  NodeIndexOutlined,
  PauseOutlined,
  PlusOutlined,
  RedoOutlined,
  StopOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { subscribeWorkflowEvents, workflowApi, WORKFLOW_NODE_STATUS_LABELS } from "../../api/production";
import { useSessionStore } from "../../stores/session-store";
import { useMembershipStore } from "../../stores/membership-store";
import type { Workflow, WorkflowEvent, WorkflowNodeStatus } from "../../types/production-types";

export interface WorkflowPanelProps {
  projectId: string;
}

const WORKFLOW_STATUS_LABELS: Record<string, { text: string; color: string }> = {
  draft: { text: "草稿", color: "default" },
  queued: { text: "排队中", color: "#3b6fe0" },
  running: { text: "执行中", color: "#3b6fe0" },
  waiting_user: { text: "等待人工审核", color: "#d98407" },
  paused: { text: "已暂停", color: "#d98407" },
  completed: { text: "已完成", color: "#2e9e62" },
  failed: { text: "已失败", color: "#d64545" },
  cancelled: { text: "已取消", color: "default" },
};

/** 节点类型 → 中文标签（V0.3：生成/审核节点） */
const NODE_TYPE_LABELS: Record<string, string> = {
  "script.generate": "生成剧本",
  "character.extract": "提取角色",
  "scene.generate": "生成场景",
  "storyboard.generate": "生成分镜",
  "image.generate": "生成图片",
  "video.generate": "生成视频",
  "review.generation": "人工审核",
};

/** 生成节点 output.summary（增量写；判空展示） */
interface GenerationSummary {
  total?: number;
  succeeded?: number;
  failed?: number;
  cancelled?: number;
  timeout?: number;
  skipped?: number;
}

function nodeIcon(status: WorkflowNodeStatus) {
  switch (status) {
    case "running":
      return <LoadingOutlined style={{ color: "var(--color-primary)" }} />;
    case "retrying":
      return <SyncOutlined spin style={{ color: "#d98407" }} />;
    case "waiting":
      return <ClockCircleOutlined style={{ color: "#d98407" }} />;
    case "completed":
      return <CheckCircleFilled style={{ color: "var(--color-success)" }} />;
    case "failed":
      return <CloseCircleFilled style={{ color: "var(--color-error)" }} />;
    case "cancelled":
      return <MinusCircleFilled style={{ color: "var(--color-text-tertiary)" }} />;
    default:
      return <span style={{ width: 14, height: 14, borderRadius: "50%", border: "1px solid var(--color-border)", display: "inline-block" }} />;
  }
}

export function WorkflowPanel({ projectId }: WorkflowPanelProps) {
  const queryClient = useQueryClient();
  const canWorkflow = useMembershipStore((s) => s.can("workflow.automation"));
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [live, setLive] = useState<Workflow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [story, setStory] = useState("");
  const [withGeneration, setWithGeneration] = useState(false);
  const [acting, setActing] = useState(false);

  const { data: workflows, isLoading, error } = useQuery({
    queryKey: ["workflows", projectId],
    queryFn: () => workflowApi.list(projectId),
  });

  // 默认选中第一个工作流
  useEffect(() => {
    if (!selectedId && workflows && workflows.length > 0) {
      setSelectedId(workflows[0]!.id);
    }
  }, [workflows, selectedId]);

  const active = useMemo(
    () => workflows?.find((wf) => wf.id === selectedId) ?? null,
    [workflows, selectedId],
  );

  // 选中工作流时同步实时状态（优先 live）
  useEffect(() => {
    setLive(null);
  }, [selectedId]);

  const workflowView = live ?? active;

  const runnable =
    canWorkflow &&
    workflowView &&
    ["draft", "queued", "paused", "failed", "waiting_user"].includes(workflowView.status);
  // waiting_user 视作运行中（挂起态）：保持 SSE 订阅并允许恢复/取消
  const running = workflowView && ["queued", "running", "waiting_user"].includes(workflowView.status);

  const refreshWorkflows = async () => {
    await queryClient.invalidateQueries({ queryKey: ["workflows", projectId] });
  };

  // SSE 订阅：工作流执行期间实时刷新节点状态
  useEffect(() => {
    if (!workflowView || !running) return;
    const controller = new AbortController();
    void subscribeWorkflowEvents(workflowView.id, (event: WorkflowEvent) => {
      if (workflowView.id !== event.workflowId) return;
      if (event.type === "workflow.snapshot") {
        setLive((prev) => {
          const base = prev ?? active;
          if (!base) return prev;
          return { ...base, status: event.status, nodes: event.nodes };
        });
        return;
      }
      setLive((prev) => {
        const base = prev ?? active;
        if (!base) return base;
        const nodes = base.nodes.map((node) => {
          if ("nodeId" in event && event.nodeId === node.id) {
            switch (event.type) {
              case "node.started":
                return { ...node, status: "running" as const };
              case "node.completed":
                return { ...node, status: "completed" as const, output: event.output };
              case "node.retrying":
                return { ...node, status: "retrying" as const, retryCount: event.attempt };
              case "node.failed":
                return { ...node, status: "failed" as const, error: event.error };
              case "node.cancelled":
                return { ...node, status: "cancelled" as const };
              case "workflow.waiting":
                return { ...node, status: "waiting" as const };
              default:
                return node;
            }
          }
          return node;
        });
        const status =
          event.type === "workflow.completed"
            ? "completed"
            : event.type === "workflow.failed"
              ? "failed"
              : event.type === "workflow.cancelled"
                ? "cancelled"
                : event.type === "workflow.paused"
                  ? "paused"
                  : event.type === "workflow.resumed"
                    ? "running"
                    : event.type === "workflow.waiting"
                      ? "waiting_user"
                      : base.status;
        return { ...base, status, nodes };
      });
    }, controller.signal).catch(() => {
      // 订阅失败（如连接断开）：由查询刷新兜底
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowView?.id, running]);

  // 终态后刷新查询（保证 DB 状态落库）
  useEffect(() => {
    if (workflowView && ["completed", "failed", "cancelled"].includes(workflowView.status)) {
      void refreshWorkflows();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowView?.status]);

  const act = async (fn: () => Promise<unknown>) => {
    setActing(true);
    try {
      await fn();
    } finally {
      setActing(false);
      await refreshWorkflows();
    }
  };

  if (!canWorkflow) {
    return (
      <Alert
        type="info"
        showIcon
        message="工作流自动化是专业版功能"
        description={
          <span>
            升级会员后即可运行生产工作流（剧本 → 角色/场景 → 分镜）。
            <a style={{ marginLeft: 8 }} onClick={() => (window.location.hash = "#/membership")}>
              前往会员中心
            </a>
          </span>
        }
      />
    );
  }

  if (isLoading) return <Skeleton active paragraph={{ rows: 4 }} />;
  if (error) return <Alert type="error" message="工作流加载失败" description={(error as Error)?.message} />;
  if (!workflows || workflows.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
              还没有工作流
            </span>
            <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", maxWidth: 320 }}>
              创建工作流后，可一键执行生产流水线（剧本 → 角色/场景 → 分镜）。
            </span>
          </div>
        }
      >
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建工作流
        </Button>
      </Empty>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
          共 {workflows.length} 个工作流 · 默认流水线：剧本 → 角色/场景 → 分镜
        </span>
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建
        </Button>
      </div>

      {workflows.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {workflows.map((wf) => {
            const st = WORKFLOW_STATUS_LABELS[wf.status] ?? { text: wf.status, color: "default" };
            return (
              <button
                key={wf.id}
                type="button"
                onClick={() => setSelectedId(wf.id)}
                style={{
                  height: 26,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: wf.id === selectedId ? "#e8effd" : "var(--color-surface)",
                  color: "var(--color-text-secondary)",
                  fontSize: 12,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <NodeIndexOutlined style={{ fontSize: 12 }} />
                {wf.id}
                <Tag style={{ marginInlineEnd: 0 }} color={st.color}>
                  {st.text}
                </Tag>
              </button>
            );
          })}
        </div>
      )}

      {workflowView && (
        <div
          style={{
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            padding: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)" }}>
              节点流水线
            </span>
            {(() => {
              const st = WORKFLOW_STATUS_LABELS[workflowView.status] ?? { text: workflowView.status, color: "default" };
              return (
                <Tag color={st.color}>
                  {st.text}
                </Tag>
              );
            })()}
            <div style={{ flex: 1 }} />
            {runnable && (
              <Tooltip title={currentSessionId ? "在会话中执行" : "请先在工作台选择会话"}>
                <Button
                  type="primary"
                  size="small"
                  icon={<CaretRightOutlined />}
                  disabled={!currentSessionId}
                  loading={acting}
                  onClick={() =>
                    act(async () => {
                      await workflowApi.run(workflowView.id, { sessionId: currentSessionId ?? "" });
                      await refreshWorkflows();
                    })
                  }
                >
                  开始运行
                </Button>
              </Tooltip>
            )}
            {running && (
              <>
                <Button
                  size="small"
                  icon={<PauseOutlined />}
                  loading={acting}
                  onClick={() => act(() => workflowApi.pause(workflowView.id))}
                >
                  暂停
                </Button>
                <Button
                  size="small"
                  icon={<CaretRightOutlined />}
                  loading={acting}
                  onClick={() => act(() => workflowApi.resume(workflowView.id))}
                >
                  恢复
                </Button>
              </>
            )}
            {running && (
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={acting}
                onClick={() => act(() => workflowApi.cancel(workflowView.id))}
              >
                取消
              </Button>
            )}
          </div>

          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {workflowView.nodes.map((node) => {
              const summary = (node.output as { summary?: GenerationSummary } | undefined)?.summary;
              return (
                <div
                  key={node.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-surface)",
                    flexWrap: "wrap",
                  }}
                >
                <span style={{ fontSize: 14, display: "inline-flex" }}>{nodeIcon(node.status)}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
                  {node.name}
                </span>
                <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                  {NODE_TYPE_LABELS[node.type] ?? node.type}
                </span>
                {summary && (
                  <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                    成功 {summary.succeeded ?? 0} · 失败 {summary.failed ?? 0} · 跳过 {summary.skipped ?? 0}
                  </span>
                )}
                <span
                  style={{
                    fontSize: 12,
                    color:
                      node.status === "failed"
                        ? "var(--color-error)"
                        : "var(--color-text-tertiary)",
                    marginLeft: "auto",
                  }}
                >
                  {WORKFLOW_NODE_STATUS_LABELS[node.status]}
                  {node.status === "failed" && node.error ? ` · ${node.error}` : ""}
                </span>
                {(node.status === "failed" || node.status === "cancelled") && workflowView.status === "failed" && (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<RedoOutlined />}
                    loading={acting}
                    onClick={() => act(() => workflowApi.retryNode(workflowView.id, node.id))}
                  >
                    重试
                  </Button>
                )}
                </div>
              );
            })}
          </div>

          {workflowView.status === "waiting_user" && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              message="等待人工审核"
              description="生成已就绪，请到「分镜 / 资产」面板对生成版本执行审核（通过 / 拒绝 / 替换）：审核完成后工作流将自动继续执行；等待期间也可在上方取消工作流。"
            />
          )}
        </div>
      )}

      <Modal
        open={createOpen}
        title="创建工作流"
        width={560}
        okText="创建"
        cancelText="取消"
        okButtonProps={{ disabled: story.trim() === "" }}
        onOk={async () => {
          await workflowApi.create(projectId, { story, withGeneration });
          setCreateOpen(false);
          setStory("");
          setWithGeneration(false);
          await refreshWorkflows();
        }}
        onCancel={() => {
          setCreateOpen(false);
          setStory("");
          setWithGeneration(false);
        }}
        destroyOnHidden
      >
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.7, marginBottom: 8 }}>
          输入故事/需求，工作流将以「剧本生成 → 角色/场景提取 → 分镜生成」顺序执行；
          勾选生成节点后追加「生成图片/视频 → 人工审核」。
        </div>
        <textarea
          value={story}
          onChange={(e) => setStory(e.target.value)}
          rows={8}
          placeholder={"如：把一个国风妖怪故事改编成 2 分钟短剧，讲述……"}
          style={{
            width: "100%",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.6,
            resize: "vertical",
            outline: "none",
          }}
        />
        <div style={{ marginTop: 10 }}>
          <Checkbox checked={withGeneration} onChange={(e) => setWithGeneration(e.target.checked)}>
            同时生成图片/视频并等待人工审核（会产生模型费用）
          </Checkbox>
        </div>
      </Modal>
    </div>
  );
}
