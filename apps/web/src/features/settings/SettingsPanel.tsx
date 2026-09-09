import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Skeleton, Tooltip, Modal, message as antdMessage } from "antd";
import {
  ApiOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  ExclamationCircleFilled,
  LoadingOutlined,
  MinusCircleOutlined,
} from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import type { ModelType, ProviderSettingsView } from "../../types/api-types";

/** 设置分组（左侧导航；当前仅「模型设置」一组，预留扩展） */
const SETTING_SECTIONS = [{ key: "llm", label: "模型设置", icon: <ApiOutlined /> }] as const;

/** 模型类型短标签（只读展示用） */
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
 * 单个供应商卡片（V0.3 系统选模型）：
 * 头部（名称/端点/验证状态）+ API Key（编辑后自动保存）+ 只读模型清单说明。
 * 用户仅需提供 API Key，模型由系统按任务类型与生成方案自动选择。
 */
function ProviderCard({
  provider,
  apiKey,
  saving,
  saved,
  verify,
  onApiKeyChange,
  onVerify,
  onRemoveKey,
}: {
  provider: ProviderSettingsView;
  apiKey: string;
  saving: boolean;
  saved: boolean;
  verify: VerifyUiState;
  onApiKeyChange: (value: string) => void;
  onVerify: () => void;
  onRemoveKey: () => void;
}) {
  // 该供应商提供的模型类型（只读，去重排序）
  const typeSet = Array.from(new Set(provider.models.map((m) => m.type)));
  const typeLabels = typeSet.length > 0 ? typeSet.map((t) => TYPE_SHORT_LABELS[t]).join(" / ") : "—";

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
        {/* 删除已配置的 Key（清空后该供应商不再参与模型选择） */}
        {provider.hasApiKey && (
          <Tooltip title="删除已配置的 API Key（清空后该供应商不再参与模型选择）">
            <button
              type="button"
              aria-label="删除 API Key"
              onClick={onRemoveKey}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                color: "var(--color-text-tertiary)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--color-error)";
                e.currentTarget.style.background = "rgba(0,0,0,0.05)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--color-text-tertiary)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <DeleteOutlined style={{ fontSize: 12 }} />
            </button>
          </Tooltip>
        )}
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

      {/* 只读：模型清单说明（模型由系统自动选择，无需用户干预） */}
      <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
        支持模型类型：{typeLabels} · 模型由系统按任务类型与生成方案自动选择
      </div>
    </div>
  );
}

/**
 * 模型设置面板（/#/settings 页面内容区）：
 * - 左侧设置导航（当前仅「模型设置」一组，预留扩展）
 * - 供应商卡片：火山引擎 / 阿里云百炼，仅需配置 API Key（自动保存）
 * - 模型由系统决定：系统按任务类型与生成方案（最省钱/均衡/高质量）自动选模型
 */
export function SettingsPanel() {
  const queryClient = useQueryClient();
  const [active, setActive] = useState<string>(SETTING_SECTIONS[0].key);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyUiState>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // 验证请求序号（丢弃过期响应，避免竞态覆盖新状态）
  const verifySeq = useRef<Record<string, number>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
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

  // 载入数据 → 初始化编辑态（API Key 输入框置空，避免回显明文）
  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const p of data.providers) next[p.id] = "";
    setApiKeys(next);
  }, [data]);

  // 载入数据 → 初始化验证状态：已配置 Key 自动验证（用已保存 Key），未配置显示灰色状态
  useEffect(() => {
    if (!data) return;
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
  }, [data, runVerify]);

  // API Key 编辑后自动保存（防抖 800ms；留空不提交，保持原值——删除走下方显式按钮）
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

  /// 删除已保存的 API Key（存空串：服务端据此将其移出「已配 Key 供应商」白名单）
  const removeKey = (provider: ProviderSettingsView) => {
    Modal.confirm({
      title: `删除「${provider.name}」的 API Key？`,
      content: "删除后该供应商将不再参与模型选择，系统会自动改用其他已配置 Key 的供应商。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await settingsApi.update({ providers: { [provider.id]: { apiKey: "" } } });
          setApiKeys((prev) => ({ ...prev, [provider.id]: "" }));
          setVerifyStates((prev) => ({
            ...prev,
            [provider.id]: { status: "no_key", message: "未配置 API Key" },
          }));
          antdMessage.success(`已删除「${provider.name}」的 API Key`);
          // 刷新 hasApiKey（输入框占位/删除按钮随之隐藏）
          await queryClient.invalidateQueries({ queryKey: ["settings"] });
        } catch (err) {
          antdMessage.error(err instanceof Error ? err.message : "删除失败");
        }
      },
    });
  };

  return (
    <div
      className="settings-layout"
      style={{ display: "flex", alignItems: "stretch", gap: 16, minHeight: 0 }}
    >
      {/* ===== 左栏：设置导航（移动端转为顶部横向滚动，见 index.css） ===== */}
      <aside
        className="settings-panel-nav"
        style={{
          width: 180,
          flexShrink: 0,
          borderRight: "1px solid var(--color-border)",
          paddingRight: 16,
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
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>模型供应商</div>
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 12 }}>
          配置各供应商 API Key 即可使用；模型由系统按任务类型与生成方案（最省钱 / 均衡 / 高质量）自动选择，无需手动选择模型。
        </div>
        {isLoading || !data ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {data.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                apiKey={apiKeys[provider.id] ?? ""}
                saving={savingId === provider.id}
                saved={savedId === provider.id}
                verify={verifyStates[provider.id] ?? { status: "no_key", message: "未配置 API Key" }}
                onApiKeyChange={(value) => onApiKeyChange(provider.id, value)}
                onVerify={() => void runVerify(provider.id)}
                onRemoveKey={() => removeKey(provider)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
