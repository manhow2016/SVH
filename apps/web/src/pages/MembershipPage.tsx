import { LeftOutlined } from "@ant-design/icons";
import { useAuthStore } from "../stores/auth-store";
import { MembershipContent } from "../features/membership/MembershipContent";

/**
 * 会员中心页（/#/membership 路由壳；顶栏「会员中心」走弹窗，复用 MembershipContent）。
 */
export function MembershipPage() {
  const { user } = useAuthStore();
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
        <span style={{ fontSize: 15, fontWeight: 600 }}>会员中心</span>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          欢迎，{user?.username}
        </span>
      </div>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 20px 64px" }}>
        <MembershipContent />
      </div>
    </div>
  );
}
