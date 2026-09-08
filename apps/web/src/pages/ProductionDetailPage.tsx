/**
 * 生产项目详情页（V0.3 布局重构）。
 *
 * 三栏：左（会话 + 模块导航）/ 中（集选择 + 内容）/ 右（Agent 对话）。
 * 多集（V0.3）：页头集选择器，按集过滤脚本/场景/分镜/镜头；角色与资产跨集共享。
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Select, Skeleton, Tag, message as antdMessage } from "antd";
import {
  ArrowLeftOutlined,
  AuditOutlined,
  DeploymentUnitOutlined,
  EnvironmentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  PictureOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { productionApi } from "../api/production";
import {
  AssetsPanel,
  CharactersPanel,
  ScenesPanel,
  ScriptsPanel,
  StoryboardsPanel,
} from "../features/production/panels";
import { ReviewQueuePanel } from "../features/production/ReviewQueuePanel";
import { WorkflowPanel } from "../features/production/WorkflowPanel";
import { ProductionCenterLayout } from "../layouts/ProductionCenterLayout";
import type { ProjectType } from "../types/production-types";

const TYPE_LABELS: Record<ProjectType, string> = {
  short_video: "短视频",
  short_drama: "短剧",
  animation: "动画",
  advertisement: "广告",
};

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  draft: { text: "草稿", color: "default" },
  planning: { text: "策划中", color: "#3b6fe0" },
  producing: { text: "制作中", color: "#d98407" },
  completed: { text: "已完成", color: "#2e9e62" },
  archived: { text: "已归档", color: "default" },
};

const SECTIONS = [
  { key: "scripts", label: "脚本", icon: <FileTextOutlined /> },
  { key: "characters", label: "角色", icon: <TeamOutlined /> },
  { key: "scenes", label: "场景", icon: <EnvironmentOutlined /> },
  { key: "storyboards", label: "分镜", icon: <PictureOutlined /> },
  { key: "review", label: "待审核", icon: <AuditOutlined /> },
  { key: "assets", label: "资产", icon: <FolderOpenOutlined /> },
  { key: "workflow", label: "工作流", icon: <DeploymentUnitOutlined /> },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function ProductionDetailPage({ projectId }: { projectId: string }) {
  const [section, setSection] = useState<SectionKey>("scripts");
  const [createEpisodeOpen, setCreateEpisodeOpen] = useState(false);
  const [episodeName, setEpisodeName] = useState("");
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  const { data: project, isLoading, error } = useQuery({
    queryKey: ["production", projectId],
    queryFn: () => productionApi.getProject(projectId),
  });
  const { data: episodes } = useQuery({
    queryKey: ["production-episodes", projectId],
    queryFn: () => productionApi.listEpisodes(projectId),
  });

  // 集按集号排序；当前集 = 用户选择（有效时）否则默认最小集号
  const episodesSorted = useMemo(
    () => [...(episodes ?? [])].sort((a, b) => a.order - b.order),
    [episodes],
  );
  const activeEpisodeId = useMemo(() => {
    if (episodesSorted.length === 0) return undefined;
    if (selectedEpisodeId && episodesSorted.some((e) => e.id === selectedEpisodeId)) {
      return selectedEpisodeId;
    }
    return episodesSorted[0]!.id;
  }, [episodesSorted, selectedEpisodeId]);
  const currentEpisode = episodesSorted.find((e) => e.id === activeEpisodeId);

  const createEpisodeMutation = useMutation({
    mutationFn: () => productionApi.createEpisode(projectId, { name: episodeName.trim() || undefined }),
    onSuccess: (episode) => {
      void queryClient.invalidateQueries({ queryKey: ["production-episodes", projectId] });
      setCreateEpisodeOpen(false);
      setEpisodeName("");
      setSelectedEpisodeId(episode.id);
      antdMessage.success(`已创建「${episode.name}」`);
    },
    onError: (err) => antdMessage.error((err as Error).message),
  });

  return (
    <ProductionCenterLayout
      leftBottom={
        <nav style={{ padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {SECTIONS.map((item) => {
            const active = section === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: 34,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: "none",
                  background: active ? "#e8effd" : "transparent",
                  color: active ? "var(--color-primary)" : "var(--color-text-secondary)",
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: 13, display: "inline-flex" }}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>
      }
      center={
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          {/* 页头（返回 + 项目名 + 状态 + 集选择） */}
          <header
            style={{
              height: 48,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "0 16px",
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              flexShrink: 0,
            }}
          >
            <a
              onClick={() => (window.location.hash = "#/production")}
              style={{ fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" }}
            >
              <ArrowLeftOutlined style={{ marginRight: 4 }} />
              制作中心
            </a>
            {project && (
              <>
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>
                  {project.name}
                </span>
                <Tag style={{ marginInlineEnd: 0 }} color={(STATUS_LABELS[project.status] ?? {}).color}>
                  {STATUS_LABELS[project.status]?.text ?? project.status}
                </Tag>
                <Tag style={{ marginInlineEnd: 0 }} color="default">
                  {TYPE_LABELS[project.type] ?? project.type}
                </Tag>
                {/* 集切换（多集 V0.3） */}
                <Select
                  size="small"
                  value={activeEpisodeId}
                  style={{ width: 150, marginLeft: 6 }}
                  onChange={setSelectedEpisodeId}
                  options={episodesSorted.map((e) => ({ value: e.id, label: e.name }))}
                  placeholder="选择集"
                />
                <Button
                  size="small"
                  type="text"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setEpisodeName("");
                    setCreateEpisodeOpen(true);
                  }}
                >
                  新建集
                </Button>
              </>
            )}
          </header>

          {/* 内容区 */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: 16 }}>
            {isLoading ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : error ? (
              <Alert type="error" showIcon message="项目加载失败" description={(error as Error)?.message} />
            ) : !project ? (
              <Alert type="warning" showIcon message="项目不存在" description="请返回制作中心列表。" />
            ) : (
              <div style={{ maxWidth: 960, margin: "0 auto" }}>
                {currentEpisode ? (
                  <div style={{ marginBottom: 12, fontSize: 12, color: "var(--color-text-tertiary)" }}>
                    当前编辑：{currentEpisode.name}
                  </div>
                ) : null}
                {section === "scripts" && <ScriptsPanel projectId={project.id} episodeId={activeEpisodeId} />}
                {section === "characters" && <CharactersPanel projectId={project.id} />}
                {section === "scenes" && <ScenesPanel projectId={project.id} episodeId={activeEpisodeId} />}
                {section === "storyboards" && (
                  <StoryboardsPanel projectId={project.id} episodeId={activeEpisodeId} />
                )}
                {section === "review" && <ReviewQueuePanel projectId={project.id} />}
                {section === "assets" && <AssetsPanel projectId={project.id} />}
                {section === "workflow" && <WorkflowPanel projectId={project.id} />}
              </div>
            )}
          </div>

          {/* 弹窗：新建集 */}
          <Modal
            open={createEpisodeOpen}
            title="新建集"
            width={380}
            okText="创建"
            cancelText="取消"
            confirmLoading={createEpisodeMutation.isPending}
            onOk={() => {
              if (!episodeName.trim()) {
                antdMessage.warning("请输入集名");
                return;
              }
              createEpisodeMutation.mutate();
            }}
            onCancel={() => setCreateEpisodeOpen(false)}
            destroyOnClose
          >
            <Input
              value={episodeName}
              onChange={(e) => setEpisodeName(e.target.value)}
              placeholder="集名，如：第 2 集（缺省自动编号）"
              onPressEnter={() => {
                if (episodeName.trim()) createEpisodeMutation.mutate();
              }}
              autoFocus
            />
          </Modal>
        </div>
      }
    />
  );
}
