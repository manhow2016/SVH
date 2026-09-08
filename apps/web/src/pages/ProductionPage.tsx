/**
 * 制作中心 - 生产项目列表页（V0.2 文档 §18）。
 *
 * 结构：独立页头（返回工作台 + 标题 + 新建项目）→ 项目列表 → 空态/加载/错误。
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Form, Input, InputNumber, Modal, Select, Skeleton, Tag } from "antd";
import { PlusOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { productionApi } from "../api/production";
import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import type { ProjectType } from "../types/production-types";

const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  short_video: "短视频",
  short_drama: "短剧",
  animation: "动画",
  advertisement: "广告",
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
      <div style={{ padding: "16px 20px 64px", maxWidth: 860, margin: "0 auto" }}>
        {projects.map((project) => {
          const status = PROJECT_STATUS_LABELS[project.status] ?? { text: project.status, color: "default" };
          return (
            <div
              key={project.id}
              role="button"
              tabIndex={0}
              onClick={() => (window.location.hash = `#/production/${project.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter") window.location.hash = `#/production/${project.id}`;
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "14px 16px",
                marginBottom: 8,
                borderRadius: 12,
                border: "1px solid var(--color-border)",
                background: "var(--color-surface)",
                cursor: "pointer",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {project.name}
                  </span>
                  <Tag style={{ marginInlineEnd: 0 }} color={status.color}>
                    {status.text}
                  </Tag>
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    color: "var(--color-text-tertiary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {PROJECT_TYPE_LABELS[project.type] ?? project.type}
                  {project.settings.duration ? ` · 目标 ${project.settings.duration}s` : ""}
                  {project.description ? ` · ${project.description}` : ""}
                </div>
              </div>
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", flexShrink: 0 }}>
                {new Date(project.updatedAt).toLocaleString("zh-CN", { hour12: false })}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--color-bg)" }}>
      <WorkbenchHeader />
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <header style={pageHeaderStyle}>
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
