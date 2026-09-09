import { ArrowLeftOutlined, CrownOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import { MembershipContent } from "../features/membership/MembershipContent";
import { useAuthStore } from "../stores/auth-store";

/**
 * 会员中心页（/#/membership 路由）。
 *
 * 结构：全局顶栏（WorkbenchHeader）+ 内容区（居中限宽容器 + 页头 + MembershipContent）。
 * 内容区整页滚动；升级套餐/订阅操作在内容区内完成。
 */
export function MembershipPage() {
  const { user } = useAuthStore();
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--color-bg)" }}>
      <WorkbenchHeader />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 24px 32px" }}>
          {/* 页头：标题 + 欢迎语 + 返回制作中心 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 8, background: "var(--color-warning-bg, #fff7e6)" }}>
                <CrownOutlined style={{ fontSize: 16, color: "var(--color-warning)" }} />
              </span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>会员中心</span>
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                欢迎，{user?.username}
              </span>
            </span>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => { window.location.hash = "#/production"; }}>
              返回制作中心
            </Button>
          </div>

          {/* 面板主体 */}
          <div style={{ paddingTop: 16 }}>
            <MembershipContent />
          </div>
        </div>
      </div>
    </div>
  );
}
