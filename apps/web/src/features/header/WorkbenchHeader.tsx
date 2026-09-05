import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, Dropdown, Modal, Tooltip } from "antd";
import {
  AppstoreOutlined,
  CrownOutlined,
  LogoutOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { settingsApi } from "../../api/settings";
import { AssetsModal } from "../assets/AssetsModal";
import { useAuthStore } from "../../stores/auth-store";
import { useMembershipStore } from "../../stores/membership-store";

/**
 * 顶部标签栏（参考 DeepSeek Harness）：
 * 左：SVH 标识；中间 2/3 处：我的资产（固定位置）；右：用户菜单 + 连接状态。
 *
 * 「我的资产」受会员功能权限 assets.library 控制（§33 前端隐藏 + 后端校验）。
 */
export function WorkbenchHeader() {
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { user, logout } = useAuthStore();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  });
  const connected = !!settings;

  const openAssets = () => {
    if (!useMembershipStore.getState().can("assets.library")) {
      setUpgradeOpen(true);
      return;
    }
    setAssetsOpen(true);
  };

  const userMenuItems = [
    { key: "account", icon: <SettingOutlined />, label: "账户设置" },
    ...(user?.role === "admin"
      ? [{ key: "admin", icon: <UserOutlined />, label: "管理控制台" }]
      : []),
    { type: "divider" as const },
    { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true },
  ];

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
        onClick={openAssets}
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

      {/* 会员中心（位于「我的资产」后面） */}
      <button
        type="button"
        onClick={() => (window.location.hash = "#/membership")}
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
        <CrownOutlined style={{ fontSize: 12 }} />
        会员中心
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

      {/* 用户菜单 */}
      <Dropdown
        menu={{
          items: userMenuItems,
          onClick: ({ key }) => {
            if (key === "logout") {
              logout();
              window.location.hash = "#/login";
            } else if (key === "account") {
              window.location.hash = "#/account";
            } else if (key === "admin") {
              window.location.hash = "#/admin";
            }
          },
        }}
        trigger={["click"]}
      >
        <button
          type="button"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 26,
            padding: "0 8px 0 4px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-secondary)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Avatar size={20} style={{ background: "var(--color-primary)", fontSize: 11 }}>
            {user?.username?.slice(0, 1).toUpperCase() ?? "U"}
          </Avatar>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {user?.username ?? ""}
          </span>
        </button>
      </Dropdown>

      <AssetsModal open={assetsOpen} onClose={() => setAssetsOpen(false)} />

      {/* 升级提示 */}
      <Modal
        open={upgradeOpen}
        title="会员功能"
        width={380}
        okText="前往会员中心"
        cancelText="取消"
        onOk={() => {
          setUpgradeOpen(false);
          window.location.hash = "#/membership";
        }}
        onCancel={() => setUpgradeOpen(false)}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          「我的资产」（全局资产库）是<b>专业版</b>及以上功能。
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 6 }}>
          升级会员后即可使用角色 / 场景 / 道具 / 音色资产库。
        </div>
      </Modal>
    </div>
  );
}
