/**
 * 生产项目详情页（V0.2 文档 §18 §19）。
 *
 * 布局：页头（返回 + 项目名 + 状态）→ 左侧导航（脚本/角色/场景/分镜/资产/工作流）+ 右侧画布。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Skeleton, Tag } from "antd";
import {
  ArrowLeftOutlined,
  DeploymentUnitOutlined,
  EnvironmentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
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
import { WorkflowPanel } from "../features/production/WorkflowPanel";
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
  { key: "assets", label: "资产", icon: <FolderOpenOutlined /> },
  { key: "workflow", label: "工作流", icon: <DeploymentUnitOutlined /> },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function ProductionDetailPage({ projectId }: { projectId: string }) {
  const [section, setSection] = useState<SectionKey>("scripts");

  const { data: project, isLoading, error } = useQuery({
    queryKey: ["production", projectId],
    queryFn: () => productionApi.getProject(projectId),
  });

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--color-bg)",
      }}
    >
      {/* 页头 */}
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
            {project.settings.duration ? (
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                目标 {project.settings.duration}s
              </span>
            ) : null}
          </>
        )}
      </header>

      {isLoading ? (
        <div style={{ padding: 20 }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : error ? (
        <div style={{ padding: 20 }}>
          <Alert
            type="error"
            showIcon
            message="项目加载失败"
            description={(error as Error)?.message || "项目可能不存在，请返回列表刷新。"}
          />
        </div>
      ) : !project ? (
        <div style={{ padding: 20 }}>
          <Alert type="warning" showIcon message="项目不存在" description="请返回制作中心列表。" />
        </div>
      ) : (
        <div style={{ display: "flex", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
          {/* 左侧导航 */}
          <aside
            style={{
              width: 168,
              flexShrink: 0,
              borderRight: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              padding: "10px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
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
          </aside>

          {/* 右侧画布 */}
          <main style={{ flex: 1, minWidth: 0, padding: 16, overflow: "auto" }}>
            <div style={{ maxWidth: 960, margin: "0 auto" }}>
              {section === "scripts" && <ScriptsPanel projectId={project.id} />}
              {section === "characters" && <CharactersPanel projectId={project.id} />}
              {section === "scenes" && <ScenesPanel projectId={project.id} />}
              {section === "storyboards" && <StoryboardsPanel projectId={project.id} />}
              {section === "assets" && <AssetsPanel projectId={project.id} />}
              {section === "workflow" && <WorkflowPanel projectId={project.id} />}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
