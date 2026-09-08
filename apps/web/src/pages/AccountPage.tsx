import { LeftOutlined } from "@ant-design/icons";
import { AccountContent } from "../features/account/AccountContent";

/**
 * 账户设置页（/#/account 路由壳；顶栏「账户设置」走弹窗，复用 AccountContent）。
 */
export function AccountPage() {
  return (
    <div style={{ height: "100vh", overflow: "auto", background: "var(--color-bg)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 48,
          padding: "0 20px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <a
          onClick={() => (window.location.hash = "#/production")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          }}
        >
          <LeftOutlined /> 返回制作中心
        </a>
        <span style={{ fontSize: 15, fontWeight: 600 }}>账户设置</span>
      </div>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 20px 64px" }}>
        <AccountContent />
      </div>
    </div>
  );
}
