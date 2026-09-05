import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Skeleton, message as antdMessage } from "antd";
import { ApiOutlined, SettingOutlined } from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import { useUIStore } from "../../stores/ui-store";
import type { ModelType, ProviderSettingsView } from "../../types/api-types";

/** 设置分组（左侧导航；当前仅「模型设置」一组，预留扩展） */
const SETTING_SECTIONS = [{ key: "llm", label: "模型设置", icon: <ApiOutlined /> }] as const;

/** 模型类型短标签 */
const TYPE_TAGS: Record<ModelType, { label: string; color: string }> = {
  text: { label: "文本", color: "var(--color-primary)" },
  image: { label: "图片", color: "var(--color-success)" },
  video: { label: "视频", color: "var(--color-warning)" },
  audio: { label: "音频", color: "var(--color-secondary)" },
};

/** 单个供应商卡片：管理员预设的模型列表 + 供应商 API Key 配置 */
function ProviderCard({
  provider,
  apiKey,
  onApiKeyChange,
}: {
  provider: ProviderSettingsView;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 520,
      }}
    >
      {/* 头部：供应商名称 + 端点地址（单行） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{provider.name}</span>
        <span
          title={provider.baseUrl}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            color: "var(--color-text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {provider.baseUrl}
        </span>
      </div>

      {/* 供应商 API Key（置于模型列表上方） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", width: 56, flexShrink: 0 }}>
          API Key
        </span>
        <Input.Password
          placeholder={provider.hasApiKey ? "已配置（留空保持不变）" : "请输入 API Key"}
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          autoComplete="new-password"
          size="small"
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>

      {/* 管理员预设的可用模型列表（只读展示，单行条目） */}
      <div
        style={{
          borderTop: "1px solid var(--color-border)",
          paddingTop: 8,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 2 }}>
          可用模型（由管理员维护）
        </div>
        {provider.models.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
            暂无可用模型，请联系管理员在后台维护
          </div>
        ) : (
          provider.models.map((model) => {
            const tag = TYPE_TAGS[model.type];
            return (
              <div
                key={model.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: 26,
                  minWidth: 0,
                }}
              >
                {/* 模型行单行：显示名称 + 模型名 + 类型标签 */}
                <span
                  style={{
                    width: 150,
                    flexShrink: 0,
                    fontSize: 12.5,
                    color: "var(--color-text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {model.displayName}
                </span>
                <span
                  title={model.modelName}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11,
                    color: "var(--color-text-tertiary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {model.modelName}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 6,
                    background: "var(--color-surface-secondary)",
                    color: tag.color,
                  }}
                >
                  {tag.label}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * 模型设置窗口（左右布局）：
 * - 供应商卡片：火山引擎 / 阿里云百炼，卡片内展示管理员预设的可用模型列表（模型名 + 类型 + 显示名称）
 * - 每个供应商可设置 API Key（服务端存储，不直出明文）
 */
export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<string>(SETTING_SECTIONS[0].key);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: open,
  });

  // 载入数据 → 初始化编辑态（API Key 输入框置空，避免回显明文）
  useEffect(() => {
    if (!data || !open) return;
    const next: Record<string, string> = {};
    for (const p of data.providers) next[p.id] = "";
    setApiKeys(next);
  }, [data, open]);

  const onSave = async () => {
    // 仅提交非空 API Key（留空 = 不修改）
    const providers: Record<string, { apiKey: string }> = {};
    for (const [id, key] of Object.entries(apiKeys)) {
      if (key.trim() !== "") providers[id] = { apiKey: key.trim() };
    }

    setSaving(true);
    try {
      await settingsApi.update({ providers });
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
      width={960}
      style={{ top: 40 }}
      footer={null}
      destroyOnClose
    >
      <div style={{ display: "flex", gap: 16, height: 600, minHeight: 0 }}>
        {/* ===== 左栏：设置导航 ===== */}
        <aside
          style={{
            width: 180,
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
                color: active === section.key ? "var(--color-primary)" : "var(--color-text-secondary)",
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

        {/* ===== 右栏：模型设置 ===== */}
        <main
          className="settings-scroll"
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "auto",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>模型供应商</div>
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 12 }}>
            模型由供应商提供，可用模型列表由管理员在后台维护；通过供应商 API Key 调用，API Key 仅保存在服务端。
          </div>
          {isLoading || !data ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : (
            <>
              {/* 供应商卡片列表（纵向排列） */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {data.providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    apiKey={apiKeys[provider.id] ?? ""}
                    onApiKeyChange={(value) =>
                      setApiKeys((prev) => ({ ...prev, [provider.id]: value }))
                    }
                  />
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <Button onClick={() => setSettingsOpen(false)}>取消</Button>
                <Button type="primary" loading={saving} onClick={() => void onSave()}>
                  保存
                </Button>
              </div>
            </>
          )}
        </main>
      </div>
    </Modal>
  );
}
