import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input, Modal, Skeleton, Switch, Tabs, Tooltip, message as antdMessage } from "antd";
import {
  ApiOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  LoadingOutlined,
  MinusCircleOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import { useUIStore } from "../../stores/ui-store";
import type { ModelType, ModelTypeMeta, ProviderSettingsView } from "../../types/api-types";

/** 设置分组（左侧导航；当前仅「模型设置」一组，预留扩展） */
const SETTING_SECTIONS = [{ key: "llm", label: "模型设置", icon: <ApiOutlined /> }] as const;

/** 模型类型短标签（Tab 用） */
const TYPE_SHORT_LABELS: Record<ModelType, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
};

/** 卡片右上角 API Key 验证状态（idle = 已配置待首验；checking = 验证中；no_key = 未配置） */
type VerifyUiStatus = "idle" | "checking" | "ok" | "fail" | "no_key";

interface VerifyUiState {
  status: VerifyUiStatus;
  message?: string;
}

/** 卡片右上角验证状态图标（点击可手动重新验证；验证中不可点击） */
function VerifyBadge({ state, onVerify }: { state: VerifyUiState; onVerify: () => void }) {
  const { status, message } = state;
  const tip =
    status === "idle"
      ? "等待验证（点击重新检测）"
      : status === "checking"
        ? "正在验证 API Key…"
        : status === "ok"
          ? "API Key 验证通过（点击重新检测）"
          : status === "fail"
            ? `API Key 验证失败：${message ?? "请检查 Key 与网络"}`
            : "未配置 API Key";
  const icon =
    status === "checking" ? (
      <LoadingOutlined style={{ fontSize: 12, color: "var(--color-primary)" }} />
    ) : status === "ok" ? (
      <CheckCircleFilled style={{ fontSize: 13, color: "var(--color-success)" }} />
    ) : status === "fail" ? (
      <ExclamationCircleFilled style={{ fontSize: 13, color: "var(--color-warning)" }} />
    ) : (
      <MinusCircleOutlined style={{ fontSize: 13, color: "var(--color-text-tertiary)" }} />
    );
  return (
    <Tooltip title={tip}>
      <span
        role="button"
        aria-label={tip}
        onClick={status === "checking" ? undefined : onVerify}
        style={{
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
          cursor: status === "checking" ? "default" : "pointer",
        }}
      >
        {icon}
      </span>
    </Tooltip>
  );
}

/**
 * 单个供应商卡片：
 * - 头部 + API Key（编辑后自动保存）
 * - 模型列表按类型（文本/图片/视频/音频）Tab 分页展示，每个模型可启用/停用（自动保存）
 */
function ProviderCard({
  provider,
  types,
  apiKey,
  saving,
  saved,
  enabledModels,
  verify,
  onApiKeyChange,
  onToggleModel,
  onVerify,
}: {
  provider: ProviderSettingsView;
  types: ModelTypeMeta[];
  apiKey: string;
  saving: boolean;
  saved: boolean;
  enabledModels: string[] | null;
  verify: VerifyUiState;
  onApiKeyChange: (value: string) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onVerify: () => void;
}) {
  const [type, setType] = useState<ModelType>("text");
  // 用户是否启用（null = 全部启用）
  const isEnabled = (modelId: string): boolean =>
    enabledModels == null || enabledModels.includes(modelId);

  const renderModelRows = (t: ModelType) => {
    const models = provider.models.filter((m) => m.type === t);
    if (models.length === 0) {
      return (
        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "4px 0" }}>
          该类型暂无可用模型
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {models.map((model) => (
          <div
            key={model.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 30,
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: 140,
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
            <Switch
              size="small"
              checked={isEnabled(model.id)}
              onChange={(checked) => onToggleModel(model.id, checked)}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        maxWidth: 520,
      }}
    >
      {/* 头部：供应商名称 + 端点地址 + 右上角 API Key 验证状态（单行） */}
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
        <VerifyBadge state={verify} onVerify={onVerify} />
      </div>

      {/* 供应商 API Key（编辑后自动保存） */}
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
          suffix={
            saving ? (
              <LoadingOutlined style={{ fontSize: 11, color: "var(--color-text-tertiary)" }} />
            ) : saved ? (
              <CheckCircleFilled style={{ fontSize: 12, color: "var(--color-success)" }} />
            ) : undefined
          }
        />
      </div>

      {/* 模型列表：按类型 Tab 分页，每个模型可启用/停用（自动保存） */}
      <Tabs
        size="small"
        activeKey={type}
        onChange={(k) => setType(k as ModelType)}
        items={types.map((t) => ({
          key: t.code,
          label: TYPE_SHORT_LABELS[t.code],
          children: renderModelRows(t.code),
        }))}
      />
    </div>
  );
}

/**
 * 模型设置窗口（左右布局）：
 * - 供应商卡片：火山引擎 / 阿里云百炼，模型列表按类型 Tab 展示，每模型可启用/停用
 * - 供应商 API Key：编辑后自动保存（服务端存储，不直出明文）
 */
export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [active, setActive] = useState<string>(SETTING_SECTIONS[0].key);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  // 用户启用的模型 id 列表（null = 全部启用）
  const [enabledModels, setEnabledModels] = useState<string[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyUiState>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const toggleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef<string[] | null>(null);
  // 验证请求序号（丢弃过期响应，避免竞态覆盖新状态）
  const verifySeq = useRef<Record<string, number>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    enabled: open,
  });

  // 触发一次供应商 API Key 验证（apiKey 缺省 = 服务端用已保存 Key）
  const runVerify = useCallback(async (providerId: string, apiKey?: string) => {
    const seq = (verifySeq.current[providerId] ?? 0) + 1;
    verifySeq.current[providerId] = seq;
    setVerifyStates((prev) => ({ ...prev, [providerId]: { status: "checking" } }));
    try {
      const result = await settingsApi.verify(providerId, apiKey);
      if (verifySeq.current[providerId] !== seq) return;
      setVerifyStates((prev) => ({
        ...prev,
        [providerId]: result.ok
          ? { status: "ok", message: result.message }
          : { status: result.status === "no_key" ? "no_key" : "fail", message: result.message },
      }));
    } catch (err) {
      if (verifySeq.current[providerId] !== seq) return;
      setVerifyStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "fail",
          message: err instanceof Error ? err.message : "验证失败",
        },
      }));
    }
  }, []);

  // 载入数据 → 初始化编辑态（API Key 输入框置空，避免回显明文；启用列表取服务端值）
  useEffect(() => {
    if (!data || !open) return;
    const next: Record<string, string> = {};
    for (const p of data.providers) next[p.id] = "";
    setApiKeys(next);
    setEnabledModels(data.enabledModels ?? null);
    enabledRef.current = data.enabledModels ?? null;
  }, [data, open]);

  // 载入数据 → 初始化验证状态：已配置 Key 自动验证（用已保存 Key），未配置显示灰色状态
  useEffect(() => {
    if (!data || !open) return;
    verifySeq.current = {};
    const init: Record<string, VerifyUiState> = {};
    for (const p of data.providers) {
      init[p.id] = p.hasApiKey
        ? { status: "idle" }
        : { status: "no_key", message: "未配置 API Key" };
    }
    setVerifyStates(init);
    for (const p of data.providers) {
      if (p.hasApiKey) void runVerify(p.id);
    }
  }, [data, open, runVerify]);

  // 全部全局可用模型 id（用户启用列表从 null 转为具体集合时使用）
  const allModelIds = useMemo(
    () => (data ? data.providers.flatMap((p) => p.models.map((m) => m.id)) : []),
    [data],
  );
  // 现存模型 id 集合：切换开关前过滤历史残留 id（管理员已删除的模型），避免提交后报「模型不存在」
  const allIdSet = useMemo(() => new Set(allModelIds), [allModelIds]);

  // API Key 编辑后自动保存（防抖 800ms；留空不提交，保持原值）
  const onApiKeyChange = (id: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [id]: value }));
    if (value.trim() === "") return;

    clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(async () => {
      setSavingId(id);
      try {
        await settingsApi.update({ providers: { [id]: { apiKey: value.trim() } } });
        setSavedId(id);
        // 保存成功后自动验证刚保存的 Key（更新右上角状态图标）
        void runVerify(id, value.trim());
      } catch (err) {
        antdMessage.error(err instanceof Error ? err.message : "自动保存失败");
      } finally {
        setSavingId(null);
      }
    }, 800);
  };

  // 模型启用开关：即时更新 UI + 防抖自动保存（合并 800ms 内的连续切换）
  const onToggleModel = (modelId: string, on: boolean) => {
    // 仅保留当前仍存在的模型 id（历史残留引用不提交，避免保存报错）
    const current = (enabledModels ?? allModelIds).filter((id) => allIdSet.has(id));
    const next = on
      ? current.includes(modelId)
        ? current
        : [...current, modelId]
      : current.filter((id) => id !== modelId);
    enabledRef.current = next;
    setEnabledModels(next);

    if (toggleTimer.current) clearTimeout(toggleTimer.current);
    toggleTimer.current = setTimeout(async () => {
      const ids = enabledRef.current;
      if (ids == null) return;
      try {
        await settingsApi.update({ enabledModels: ids });
      } catch (err) {
        antdMessage.error(err instanceof Error ? err.message : "自动保存失败");
      }
    }, 800);
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
      destroyOnHidden
    >
      <div className="settings-modal-body" style={{ display: "flex", gap: 16, height: 600, minHeight: 0 }}>
        {/* ===== 左栏：设置导航（移动端转为顶部横向滚动，见 index.css） ===== */}
        <aside
          className="settings-modal-nav"
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
              className="settings-nav-item"
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
              {/* 供应商卡片列表（纵向排列；API Key 与模型启用开关编辑后自动保存） */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {data.providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    types={data.catalog.types}
                    apiKey={apiKeys[provider.id] ?? ""}
                    saving={savingId === provider.id}
                    saved={savedId === provider.id}
                    enabledModels={enabledModels}
                    verify={
                      verifyStates[provider.id] ?? { status: "no_key", message: "未配置 API Key" }
                    }
                    onApiKeyChange={(value) => onApiKeyChange(provider.id, value)}
                    onToggleModel={onToggleModel}
                    // 手动重验：输入框有草稿则验证草稿 Key，否则验证已保存 Key
                    onVerify={() =>
                      void runVerify(provider.id, apiKeys[provider.id]?.trim() || undefined)
                    }
                  />
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </Modal>
  );
}
