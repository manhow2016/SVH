import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Input, Modal, Skeleton, message as antdMessage } from "antd";
import { ApiOutlined, SettingOutlined } from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import { useUIStore } from "../../stores/ui-store";

interface FormValues {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 设置分组（左侧导航；当前仅「模型设置」一组，预留扩展） */
const SETTING_SECTIONS = [{ key: "llm", label: "模型设置", icon: <ApiOutlined /> }] as const;

/**
 * 模型设置窗口（左右布局）：
 * 左侧设置导航，右侧为对应设置的编辑表单（LLM Provider / Base URL / API Key / Model）。
 * API Key 仅保存在服务端（settings 表），前端只读回 hasApiKey。
 */
export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<string>(SETTING_SECTIONS[0].key);

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: open,
  });

  useEffect(() => {
    if (data && open) {
      form.setFieldsValue({
        baseUrl: data.llm.baseUrl,
        model: data.llm.model,
        apiKey: "",
      });
    }
  }, [data, open, form]);

  const onSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await settingsApi.update({
        baseUrl: values.baseUrl,
        model: values.model,
        // 留空表示不修改；输入非空值才覆盖
        ...(values.apiKey.trim() !== "" ? { apiKey: values.apiKey } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      antdMessage.success("模型设置已保存");
      setSettingsOpen(false);
    } catch (err) {
      antdMessage.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={() => setSettingsOpen(false)}
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <SettingOutlined style={{ color: "var(--color-primary)" }} />
          设置
        </span>
      }
      width={860}
      style={{ top: 48 }}
      footer={null}
      destroyOnClose
    >
      <div style={{ display: "flex", gap: 16, height: 480, minHeight: 0 }}>
        {/* ===== 左栏：设置导航 ===== */}
        <aside
          style={{
            width: 200,
            flexShrink: 0,
            borderRight: "1px solid var(--color-border)",
            paddingRight: 12,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-tertiary)", marginBottom: 8 }}>
            设置项
          </div>
          {SETTING_SECTIONS.map((section) => (
            <button
              key={section.key}
              type="button"
              onClick={() => setActive(section.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 34,
                padding: "0 10px",
                borderRadius: 6,
                border: "none",
                background: active === section.key ? "var(--color-surface-secondary)" : "transparent",
                color:
                  active === section.key
                    ? "var(--color-primary)"
                    : "var(--color-text-secondary)",
                fontSize: 12.5,
                fontWeight: active === section.key ? 600 : 400,
                cursor: "pointer",
                textAlign: "left",
                marginBottom: 2,
              }}
            >
              {section.icon}
              {section.label}
            </button>
          ))}
        </aside>

        {/* ===== 右栏：设置内容 ===== */}
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>LLM Provider</div>
          {isLoading ? (
            <Skeleton active paragraph={{ rows: 5 }} />
          ) : (
            <>
              <Form form={form} layout="vertical" size="middle">
                <Form.Item
                  label="Base URL"
                  name="baseUrl"
                  rules={[{ required: true, message: "请输入 Base URL" }]}
                >
                  <Input placeholder="https://api.deepseek.com / http://localhost:11434/v1" />
                </Form.Item>
                <Form.Item
                  label="API Key"
                  name="apiKey"
                  extra={
                    data?.llm.hasApiKey
                      ? "服务端已配置 API Key，留空保持不变"
                      : "服务端未配置 API Key"
                  }
                >
                  <Input.Password placeholder="sk-..." autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                  label="模型"
                  name="model"
                  rules={[{ required: true, message: "请输入模型名称" }]}
                >
                  <Input placeholder="deepseek-chat" />
                </Form.Item>
              </Form>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Button onClick={() => setSettingsOpen(false)}>取消</Button>
                <Button type="primary" loading={saving} onClick={() => void onSave()}>
                  保存
                </Button>
              </div>
              <div
                style={{
                  marginTop: 16,
                  fontSize: 11,
                  color: "var(--color-text-tertiary)",
                  lineHeight: 1.8,
                }}
              >
                API Key 仅保存在服务端，不会返回前端。也可通过环境变量 SVH_LLM_BASE_URL /
                SVH_LLM_API_KEY / SVH_LLM_MODEL 配置。
              </div>
            </>
          )}
        </main>
      </div>
    </Modal>
  );
}
