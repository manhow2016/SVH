import type { CSSProperties, ReactNode } from "react";
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
import { AccountContent } from "../account/AccountContent";
import { MembershipContent } from "../membership/MembershipContent";
import { SettingsModal } from "../settings/SettingsModal";
import { useAuthStore } from "../../stores/auth-store";
import { useMembershipStore } from "../../stores/membership-store";
import { useUIStore } from "../../stores/ui-store";
import { useIsMobile } from "../../hooks/use-is-mobile";

/**
 * 顶栏导航按钮：统一描边风格（.header-nav-btn）+ 功能色图标。
 * 移动端（≤768px）文字隐藏、仅保留彩色图标（见 index.css）。
 */
function NavButton({
  label,
  icon,
  accent,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  accent: string;
  onClick: () => void;
}) {
  const style = { "--nav-accent": accent } as CSSProperties;
  return (
    <button type="button" className="header-nav-btn" style={style} onClick={onClick}>
      <span style={{ display: "inline-flex", color: accent }}>{icon}</span>
      <span className="header-nav-label">{label}</span>
    </button>
  );
}

/**
 * 全局顶栏：SVH 标识 + 我的资产 + 模型设置 + 会员中心（弹窗）+ 用户菜单
 * （账户设置弹窗 / 管理控制台 / 退出登录）。连接状态指示已移除。
 */
export function WorkbenchHeader() {
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);
  const { user, logout } = useAuthStore();
  const isMobile = useIsMobile();

  /** 我的资产为独立页面（#/assets），入口保留会员功能鉴权 */
  const openAssets = () => {
    if (!useMembershipStore.getState().can("assets.library")) {
      setUpgradeOpen(true);
      return;
    }
    window.location.hash = "#/assets";
  };

  /** 用户菜单点击（顶栏与移动端「我的」Tab 共用） */
  const onUserMenuClick = ({ key }: { key: string }) => {
    if (key === "logout") {
      logout();
      window.location.hash = "#/login";
    } else if (key === "account") {
      setAccountOpen(true);
    } else if (key === "admin") {
      window.location.hash = "#/admin";
    }
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

      {/* 功能入口：桌面为独立彩色按钮；移动端移入底部 TabBar（小程序布局） */}
      {!isMobile && (
        <>
          {/* 我的资产（固定位于导航栏左边 2/3 处） */}
          <NavButton
            label="我的资产"
            accent="var(--color-success)"
            icon={<AppstoreOutlined style={{ fontSize: 13 }} />}
            onClick={openAssets}
          />

          {/* 模型设置（原「制作中心」按钮位；打开模型/供应商配置弹窗） */}
          <NavButton
            label="模型设置"
            accent="var(--color-primary)"
            icon={<ApiOutlined style={{ fontSize: 13 }} />}
            onClick={() => useUIStore.getState().setSettingsOpen(true)}
          />

          {/* 会员中心（弹窗） */}
          <NavButton
            label="会员中心"
            accent="var(--color-warning)"
            icon={<CrownOutlined style={{ fontSize: 13 }} />}
            onClick={() => setMembershipOpen(true)}
          />
        </>
      )}

      <div style={{ flex: 1 }} />

      {/* 用户菜单（移动端由底部「我的」Tab 承担） */}
      {!isMobile && (
        <Dropdown
          menu={{ items: userMenuItems, onClick: onUserMenuClick }}
          trigger={["click"]}
        >
          <button
            type="button"
            className="header-nav-btn"
            style={{ "--nav-accent": "var(--color-primary)" } as CSSProperties}
          >
            <Avatar size={20} style={{ background: "var(--color-primary)", fontSize: 11 }}>
              {user?.username?.slice(0, 1).toUpperCase() ?? "U"}
            </Avatar>
            <span className="header-nav-label header-username" style={{ fontSize: 12 }}>
              {user?.username ?? ""}
            </span>
          </button>
        </Dropdown>
      )}

      {/* 移动端底部 TabBar（小程序布局）：功能入口 + 我的（用户菜单） */}
      {isMobile && (
        <nav className="mobile-tabbar" aria-label="全局导航">
          <button type="button" className="mobile-tab" onClick={openAssets}>
            <AppstoreOutlined className="mobile-tab-icon" style={{ color: "var(--color-success)" }} />
            <span>我的资产</span>
          </button>
          <button
            type="button"
            className="mobile-tab"
            onClick={() => useUIStore.getState().setSettingsOpen(true)}
          >
            <ApiOutlined className="mobile-tab-icon" style={{ color: "var(--color-primary)" }} />
            <span>模型设置</span>
          </button>
          <button type="button" className="mobile-tab" onClick={() => setMembershipOpen(true)}>
            <CrownOutlined className="mobile-tab-icon" style={{ color: "var(--color-warning)" }} />
            <span>会员中心</span>
          </button>
          <Dropdown menu={{ items: userMenuItems, onClick: onUserMenuClick }} trigger={["click"]}>
            <button type="button" className="mobile-tab">
              <Avatar size={20} style={{ background: "var(--color-primary)", fontSize: 11 }}>
                {user?.username?.slice(0, 1).toUpperCase() ?? "U"}
              </Avatar>
              <span>我的</span>
            </button>
          </Dropdown>
        </nav>
      )}

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
