import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tooltip } from "antd";
import { AppstoreOutlined } from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import { AssetsModal } from "../assets/AssetsModal";

/**
 * 顶部标签栏（参考 DeepSeek Harness）：
 * 左：SVH 标识；中间 2/3 处：我的资产（固定位置）；右：连接状态（设置入口在左侧边栏底部）。
 */
export function WorkbenchHeader() {
  const [assetsOpen, setAssetsOpen] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  });
  const connected = !!settings;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 40,
        padding: "0 10px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        flexShrink: 0,
      }}
    >
      {/* 左侧：SVH 标识 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontWeight: 700,
            fontSize: 13,
            color: "var(--color-primary)",
            letterSpacing: 0.5,
          }}
        >
          SVH
        </span>
      </div>

      {/* 占位 2/3：按钮左侧空间占 2/3 */}
      <div style={{ flex: 2 }} />

      {/* 我的资产（固定位于导航栏左边 2/3 处） */}
      <button
        type="button"
        onClick={() => setAssetsOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          padding: "0 10px",
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-secondary)",
          color: "var(--color-text-secondary)",
          fontSize: 12,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <AppstoreOutlined style={{ fontSize: 12 }} />
        我的资产
      </button>

      {/* 占位 1/3：按钮右侧空间占 1/3 */}
      <div style={{ flex: 1 }} />

      {/* 连接状态 */}
      <Tooltip title={connected ? "Server 已连接" : "Server 连接失败"}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: connected ? "var(--color-success)" : "var(--color-error)",
            display: "inline-flex",
            flexShrink: 0,
          }}
        />
      </Tooltip>

      <AssetsModal open={assetsOpen} onClose={() => setAssetsOpen(false)} />
    </div>
  );
}
