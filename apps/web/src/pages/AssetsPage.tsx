import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import { AssetsPanel } from "../features/assets/AssetsPanel";
import { useIsMobile } from "../hooks/use-is-mobile";

/**
 * 我的资产 - 独立页面（hash 路由 `#/assets`）。
 *
 * 结构：全局顶栏（WorkbenchHeader）+ 内容区（居中限宽容器 + AssetsPanel）。
 * 内容区整页滚动，面板内的文件夹列表、类型页签各自独立滚动。
 */
export function AssetsPage() {
  const isMobile = useIsMobile();
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--color-bg)" }}>
      <WorkbenchHeader />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <div style={{ maxWidth: 1160, margin: "0 auto", padding: isMobile ? "12px 12px 24px" : "20px 24px 32px" }}>
          <AssetsPanel />
        </div>
      </div>
    </div>
  );
}
