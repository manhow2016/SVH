import { ArrowLeftOutlined, SettingOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import { SettingsPanel } from "../features/settings/SettingsPanel";

/**
 * 模型设置页（/#/settings 路由壳）。
 *
 * 结构：全局顶栏（WorkbenchHeader）+ 内容区（居中限宽容器 + 页头 + SettingsPanel）。
 * 内容区整页滚动，面板内部的导航/卡片随页面自然高度排布。
 */
export function SettingsPage() {
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--color-bg)" }}>
      <WorkbenchHeader />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 24px 32px" }}>
          {/* 页头：标题 + 返回制作中心 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 8, background: "var(--color-primary-bg, #e6f4ff)" }}>
                <SettingOutlined style={{ fontSize: 16, color: "var(--color-primary)" }} />
              </span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>模型设置</span>
            </span>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => { window.location.hash = "#/production"; }}>
              返回制作中心
            </Button>
          </div>

          {/* 面板主体 */}
          <div style={{ paddingTop: 16 }}>
            <SettingsPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
