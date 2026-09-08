import { useState } from "react";
import { Avatar, Dropdown, Modal } from "antd";
import {
  ApiOutlined,
  AppstoreOutlined,
  CrownOutlined,
  LogoutOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { AssetsModal } from "../assets/AssetsModal";
import { AccountContent } from "../account/AccountContent";
import { MembershipContent } from "../membership/MembershipContent";
import { SettingsModal } from "../settings/SettingsModal";
import { useAuthStore } from "../../stores/auth-store";
import { useMembershipStore } from "../../stores/membership-store";
import { useUIStore } from "../../stores/ui-store";

/**
 * 全局顶栏：SVH 标识 + 我的资产 + 模型设置 + 会员中心（弹窗）+ 用户菜单
 * （账户设置弹窗 / 管理控制台 / 退出登录）。连接状态指示已移除。
 */
export function WorkbenchHeader() {
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);
  const { user, logout } = useAuthStore();

  const openAssets = () => {
    if (!useMembershipStore.getState().can("assets.library")) {
      setUpgradeOpen(true);
      return;
    }
    setAssetsOpen(true);
  };

  const userMenuItems = [
    // V0.3：账户设置改为弹窗（账户设置 → setAccountOpen）
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

      {/* 模型设置（原「制作中心」按钮位；打开模型/供应商配置弹窗） */}
      <button
        type="button"
        onClick={() => useUIStore.getState().setSettingsOpen(true)}
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
        <ApiOutlined style={{ fontSize: 12 }} />
        模型设置
      </button>

      {/* 会员中心（弹窗） */}
      <button
        type="button"
        onClick={() => setMembershipOpen(true)}
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

      <div style={{ flex: 1 }} />

      {/* 用户菜单 */}
      <Dropdown
        menu={{
          items: userMenuItems,
          onClick: ({ key }) => {
            if (key === "logout") {
              logout();
              window.location.hash = "#/login";
            } else if (key === "account") {
              setAccountOpen(true);
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

      {/* 模型/供应商配置（全局弹窗；页头「模型设置」按钮与路由页共用） */}
      <SettingsModal />

      {/* 账户设置弹窗 */}
      <Modal
        open={accountOpen}
        title="账户设置"
        width={640}
        footer={null}
        onCancel={() => setAccountOpen(false)}
        destroyOnHidden
      >
        <AccountContent />
      </Modal>

      {/* 会员中心弹窗 */}
      <Modal
        open={membershipOpen}
        title="会员中心"
        width={860}
        footer={null}
        onCancel={() => setMembershipOpen(false)}
        destroyOnHidden
      >
        <MembershipContent />
      </Modal>

      {/* 升级提示 */}
      <Modal
        open={upgradeOpen}
        title="会员功能"
        width={380}
        okText="前往会员中心"
        cancelText="取消"
        onOk={() => {
          setUpgradeOpen(false);
          setMembershipOpen(true);
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
