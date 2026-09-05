import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  AutoComplete,
  Button,
  Input,
  Modal,
  Select,
  Skeleton,
  message as antdMessage,
} from "antd";
import { ApiOutlined, SettingOutlined } from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import { useUIStore } from "../../stores/ui-store";
import type {
  ModelCatalog,
  ModelType,
  ModelTypeConfig,
  ProviderApiKey,
} from "../../types/api-types";

/** 设置分组（左侧导航；当前仅「模型设置」一组，预留扩展） */
const SETTING_SECTIONS = [{ key: "llm", label: "模型设置", icon: <ApiOutlined /> }] as const;

/** 模型类型中文名（提示使用） */
const TYPE_LABELS: Record<ModelType, string> = {
  text: "文本模型",
  image: "图片模型",
  video: "视频模型",
  audio: "音频模型",
};

/** 本地编辑态：供应商 API Key（输入框值；留空 = 不修改） + 模型类型选择 */
interface EditState {
  apiKeys: Record<string, string>;
  baseUrls: Record<string, string>;
  modelConfigs: Record<ModelType, ModelTypeConfig>;
}

/**
 * 模型设置窗口（左右布局）：
 * - 供应商配置：火山引擎 / 阿里云百炼 / 自定义，各自保存 API Key（服务端存储，不直出明文）
 * - 模型类型：文本 / 图片 / 视频 / 音频，每个类型选择供应商 + 模型（可手动输入模型名）
 */
export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<string>(SETTING_SECTIONS[0].key);
  const [edit, setEdit] = useState<EditState | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: open,
  });

  // 载入数据 → 初始化编辑态（API Key 输入框置空，避免回显明文）
  useEffect(() => {
    if (!data || !open) return;
    const s = data.models;
    const apiKeys: Record<string, string> = {};
    const baseUrls: Record<string, string> = {};
    for (const p of s.providers) {
      apiKeys[p.id] = "";
      if (p.baseUrl) baseUrls[p.id] = p.baseUrl;
    }
    setEdit({
      apiKeys,
      baseUrls,
      modelConfigs: {
        text: { ...s.models.text },
        image: { ...s.models.image },
        video: { ...s.models.video },
        audio: { ...s.models.audio },
      },
    });
  }, [data, open]);

  const catalog: ModelCatalog | undefined = data?.catalog;

  const onSave = async () => {
    if (!edit) return;
    // 校验：每个类型必须选择供应商 + 模型名
    const types = Object.entries(edit.modelConfigs) as Array<[ModelType, ModelTypeConfig]>;
    for (const [type, cfg] of types) {
      if (!cfg.provider) {
        antdMessage.warning(`请为「${TYPE_LABELS[type]}」选择供应商`);
        return;
      }
      if (!cfg.model.trim()) {
        antdMessage.warning(`请为「${TYPE_LABELS[type]}」填写模型名称`);
        return;
      }
    }

    setSaving(true);
    try {
      // 供应商：仅提交有 API Key 或 baseUrl 变化的项；留空 = 不修改
      const providers: Record<string, Partial<ProviderApiKey>> = {};
      for (const [id, key] of Object.entries(edit.apiKeys)) {
        if (key.trim() !== "") {
          providers[id] = { ...(providers[id] ?? {}), apiKey: key.trim() };
        }
        const baseUrl = edit.baseUrls[id];
        if (baseUrl !== undefined && baseUrl.trim() !== "") {
          providers[id] = { ...(providers[id] ?? {}), baseUrl: baseUrl.trim() };
        }
      }
      // 模型类型：全部提交
      const models: Partial<Record<ModelType, ModelTypeConfig>> = {};
      for (const [type, cfg] of types) {
        models[type] = { provider: cfg.provider, model: cfg.model.trim() };
      }
      await settingsApi.update({ providers, models });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      antdMessage.success("模型设置已保存");
      setSettingsOpen(false);
    } catch (err) {
      antdMessage.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = useMemo(
    () => (catalog?.providers ?? []).map((p) => ({ value: p.id, label: p.name })),
    [catalog],
  );

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
      width={900}
      style={{ top: 40 }}
      footer={null}
      destroyOnClose
    >
      <div style={{ display: "flex", gap: 16, height: 560, minHeight: 0 }}>
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
            模型由供应商提供，通过供应商 API Key 调用；API Key 仅保存在服务端。
          </div>
          {isLoading || !edit || !catalog ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : (
            <>
              {/* 供应商 API Key */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {catalog.providers.map((provider) => {
                  const hasKey = data!.models.providers.find((p) => p.id === provider.id)?.hasApiKey;
                  return (
                    <div
                      key={provider.id}
                      style={{
                        border: "1px solid var(--color-border)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                      }}
                    >
                      <div style={{ width: 150, flexShrink: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{provider.name}</div>
                        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                          {provider.fixedEndpoint ? "固定端点" : "自备端点"}
                        </div>
                      </div>
                      {provider.id === "custom" ? (
                        <Input
                          placeholder="Base URL，如 https://api.example.com/v1"
                          value={edit.baseUrls[provider.id] ?? ""}
                          onChange={(e) =>
                            setEdit((prev) =>
                              prev
                                ? { ...prev, baseUrls: { ...prev.baseUrls, [provider.id]: e.target.value } }
                                : prev,
                            )
                          }
                        />
                      ) : (
                        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", flex: 1 }}>
                          {provider.baseUrl}
                        </div>
                      )}
                      <Input.Password
                        placeholder={hasKey ? "已配置（留空保持不变）" : "请输入 API Key"}
                        value={edit.apiKeys[provider.id] ?? ""}
                        onChange={(e) =>
                          setEdit((prev) =>
                            prev
                              ? { ...prev, apiKeys: { ...prev.apiKeys, [provider.id]: e.target.value } }
                              : prev,
                          )
                        }
                        autoComplete="new-password"
                        style={{ width: 320, flexShrink: 0 }}
                      />
                    </div>
                  );
                })}
              </div>

              {/* 模型类型 */}
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 20, marginBottom: 2 }}>
                模型类型
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 10 }}>
                每个类型独立配置供应商与模型（文本 / 图片 / 视频 / 音频）。
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 10,
                }}
              >
                {catalog.types.map((type) => {
                  const cfg = edit.modelConfigs[type.code];
                  const provider = catalog.providers.find((p) => p.id === cfg?.provider);
                  const suggestions = provider?.models[type.code] ?? [];
                  return (
                    <div
                      key={type.code}
                      style={{
                        border: "1px solid var(--color-border)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{type.label}</span>
                        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
                          {type.description}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Select
                          value={cfg?.provider}
                          options={providerOptions}
                          onChange={(v) =>
                            setEdit((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    modelConfigs: {
                                      ...prev.modelConfigs,
                                      [type.code]: { provider: v, model: prev.modelConfigs[type.code].model },
                                    },
                                  }
                                : prev,
                            )
                          }
                          placeholder="供应商"
                          style={{ width: 150, flexShrink: 0 }}
                          size="small"
                        />
                        <AutoComplete
                          value={cfg?.model}
                          options={suggestions.map((m) => ({ value: m }))}
                          onChange={(v) =>
                            setEdit((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    modelConfigs: {
                                      ...prev.modelConfigs,
                                      [type.code]: { ...prev.modelConfigs[type.code], model: v },
                                    },
                                  }
                                : prev,
                            )
                          }
                          placeholder="选择或输入模型名"
                          style={{ flex: 1, minWidth: 0 }}
                          size="small"
                          filterOption={(input, option) =>
                            String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <Alert
                type="info"
                showIcon
                style={{ marginTop: 14, fontSize: 12 }}
                message="提示"
                description={
                  <span style={{ fontSize: 12, lineHeight: 1.8 }}>
                    文本模型用于对话 Agent；图片 / 视频 / 音频模型为对应生成能力预留。
                    <br />
                    也可通过环境变量 SVH_LLM_BASE_URL / SVH_LLM_API_KEY / SVH_LLM_MODEL 提供兜底默认。
                  </span>
                }
              />

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
