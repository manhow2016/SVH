/**
 * 制作中心 - 生产项目列表页（V0.2 文档 §18）。
 *
 * 结构：独立页头（返回工作台 + 标题 + 新建项目）→ 项目网格卡片 → 空态/加载/错误。
 * 卡片：彩色类型图标块 + 状态 Tag + 类型/时长彩色文字 + 摘要，悬停抬升（.project-card）。
 * 响应式：≤768px 单列卡片、页头收紧（见 index.css）。
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Form, Input, InputNumber, Modal, Select, Skeleton, Tag } from "antd";
import {
  NotificationOutlined,
  PlaySquareOutlined,
  PlusOutlined,
  RightOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { productionApi } from "../api/production";
import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import type { ProjectType } from "../types/production-types";

const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  short_video: "短视频",
  short_drama: "短剧",
  animation: "动画",
  advertisement: "广告",
};

/** 类型视觉元数据：彩色图标 + 类型色（图标块底色用 10% 透明度叠加） */
const PROJECT_TYPE_META: Record<ProjectType, { color: string; icon: ReactNode }> = {
  short_video: { color: "#3b6fe0", icon: <VideoCameraOutlined /> },
  short_drama: { color: "#8a5cf5", icon: <PlaySquareOutlined /> },
  animation: { color: "#2e9e62", icon: <ThunderboltOutlined /> },
  advertisement: { color: "#d98407", icon: <NotificationOutlined /> },
};

const PROJECT_STATUS_LABELS: Record<string, { text: string; color: string }> = {
  draft: { text: "草稿", color: "default" },
  planning: { text: "策划中", color: "#3b6fe0" },
  producing: { text: "制作中", color: "#d98407" },
  completed: { text: "已完成", color: "#2e9e62" },
  archived: { text: "已归档", color: "default" },
};

const pageHeaderStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 10,
  height: 48,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "0 16px",
  borderBottom: "1px solid var(--color-border)",
  background: "var(--color-surface)",
};

/** 更新时间：MM-DD HH:mm，移动端不溢出 */
const formatUpdatedAt = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export function ProductionPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: projects, isLoading, error } = useQuery({
    queryKey: ["productions"],
    queryFn: () => productionApi.listProjects(),
  });

  const [form] = Form.useForm();

  const createProject = async () => {
    const values = await form.validateFields();
    await productionApi.createProject({
      name: values.name,
      type: values.type,
      description: values.description,
      // antd InputNumber 未填写时值为 null，后端仅接受正数，统一转 undefined
      duration: values.duration ?? undefined,
      style: values.style,
    });
    setCreateOpen(false);
    form.resetFields();
    await queryClient.invalidateQueries({ queryKey: ["productions"] });
  };

  const renderBody = () => {
    if (isLoading) {
      return (
        <div style={{ padding: 20 }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      );
    }
    if (error) {
      return (
        <Alert
          type="error"
          showIcon
          style={{ margin: 20 }}
          message="项目列表加载失败"
          description={(error as Error)?.message || "请稍后重试，或检查服务是否在线。"}
        />
      );
    }
    if (!projects || projects.length === 0) {
      return (
        <Empty
          style={{ margin: 80 }}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
                还没有生产项目
              </span>
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", maxWidth: 300 }}>
                创建项目后，可通过对话让 Agent 生成剧本、角色、分镜并执行生产工作流。
              </span>
            </div>
          }
        >
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建项目
          </Button>
        </Empty>
      );
    }
    return (
      <div className="project-page-body" style={{ maxWidth: 860, margin: "0 auto" }}>
        <div className="project-grid">
          {projects.map((project) => {
            const status = PROJECT_STATUS_LABELS[project.status] ?? {
              text: project.status,
              color: "default",
            };
            const meta = PROJECT_TYPE_META[project.type] ?? {
              color: "var(--color-primary)",
              icon: <VideoCameraOutlined />,
            };
            const typeLabel = PROJECT_TYPE_LABELS[project.type] ?? project.type;
            return (
              <div
                key={project.id}
                role="button"
                tabIndex={0}
                className="project-card"
                onClick={() => (window.location.hash = `#/production/${project.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") window.location.hash = `#/production/${project.id}`;
                }}
              >
                {/* 彩色类型图标块：类型色 10% 底色 + 纯色图标 */}
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: `${meta.color}1a`,
                    color: meta.color,
                  }}
                >
                  <span style={{ fontSize: 20 }}>{meta.icon}</span>
                </div>

                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {/* 标题 + 状态 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: "var(--color-text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {project.name}
                    </span>
                    <Tag style={{ marginInlineEnd: 0 }} color={status.color}>
                      {status.text}
                    </Tag>
                  </div>

                  {/* 类型（彩色文字）+ 目标时长（主色浅底） */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: meta.color }}>
                      {typeLabel}
                    </span>
                    {project.settings.duration ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--color-primary)",
                          background: "rgba(59, 111, 224, 0.08)",
                          borderRadius: 4,
                          padding: "1px 6px",
                        }}
                      >
                        目标 {project.settings.duration}s
                      </span>
                    ) : null}
                  </div>

                  {/* 摘要（最多两行） */}
                  {project.description ? (
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.6,
                        color: "var(--color-text-secondary)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {project.description}
                    </div>
                  ) : null}

                  {/* 底部：更新时间 + 进入箭头 */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginTop: "auto",
                      paddingTop: 4,
                    }}
                  >
                    <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
                      更新于 {formatUpdatedAt(project.updatedAt)}
                    </span>
                    <RightOutlined style={{ fontSize: 11, color: "var(--color-text-tertiary)" }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--color-bg)" }}>
      <WorkbenchHeader />
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <header className="project-page-header" style={pageHeaderStyle}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>
              <VideoCameraOutlined style={{ marginRight: 6, color: "var(--color-primary)" }} />
              制作中心
            </span>
            <div style={{ flex: 1 }} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建项目
            </Button>
          </header>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {renderBody()}
          </div>

          <Modal
            open={createOpen}
            title="新建生产项目"
            width={520}
            okText="创建"
            cancelText="取消"
            onOk={async () => {
              await createProject();
            }}
            onCancel={() => {
              setCreateOpen(false);
              form.resetFields();
            }}
            destroyOnHidden
          >
            <Form form={form} layout="vertical" initialValues={{ type: "short_drama" }}>
              <Form.Item label="项目名称" name="name" rules={[{ required: true, message: "请输入项目名称" }]}>
                <Input placeholder="如：两分钟国风短剧" maxLength={100} />
              </Form.Item>
              <Form.Item label="项目类型" name="type">
                <Select
                  options={[
                    { value: "short_video", label: "短视频" },
                    { value: "short_drama", label: "短剧" },
                    { value: "animation", label: "动画" },
                    { value: "advertisement", label: "广告" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="目标时长（秒）" name="duration">
                <InputNumber min={1} placeholder="如：120" style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="风格" name="style">
                <Input placeholder="如：chinese_fantasy" maxLength={100} />
              </Form.Item>
              <Form.Item label="项目说明" name="description">
                <Input.TextArea rows={3} maxLength={2000} placeholder="一句话描述故事背景与目标" />
              </Form.Item>
            </Form>
          </Modal>
        </div>
    </div>
  );
}
