import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Form, Input, message as antdMessage, Skeleton } from "antd";
import { settingsApi } from "../../api/settings";
import { useUIStore } from "../../stores/ui-store";

interface FormValues {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Settings Drawer（文档 §45）：
 * LLM Provider / Base URL / API Key / Model。
 * API Key 仅保存在服务端（settings 表），前端只读回 hasApiKey。
 */
export function SettingsDrawer() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);

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
    <Drawer
      open={open}
      onClose={() => setSettingsOpen(false)}
      title="模型设置"
      width={420}
      styles={{ body: { paddingTop: 8 } }}
    >
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : (
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
              data?.llm.hasApiKey ? "服务端已配置 API Key，留空保持不变" : "服务端未配置 API Key"
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
        </Form>
      )}
    </Drawer>
  );
}
