import { useEffect, useState, type ReactNode } from "react";
import { Tooltip } from "antd";
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  VerticalLeftOutlined,
  VerticalRightOutlined,
} from "@ant-design/icons";
import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import { WorkspaceSidebar } from "../features/sidebar/WorkspaceSidebar";
import { WorkspaceExplorer } from "../features/workspace/WorkspaceExplorer";
import { FileViewer } from "../features/workspace/FileViewer";
import { SettingsModal } from "../features/settings/SettingsModal";
import { useUIStore } from "../stores/ui-store";

const SIDEBAR_WIDTH = 280;
/** 右侧工作区面板宽度（顶栏按钮需与之对齐时复用） */
export const PANEL_WIDTH = 340;

/**
 * WorkbenchLayout（参考 DeepSeek Harness 三栏布局）：
 * 顶部标签栏 + 左（会话）/ 中（对话）/ 右（文件树 + 文件查看）+ 各自内部滚动。
 * 左右两侧面板均可折叠为窄条。
 */
export function WorkbenchLayout({ center }: { center: ReactNode }) {
  const { sidebarCollapsed, workspacePanelCollapsed, toggleSidebar, toggleWorkspacePanel } =
    useUIStore();

  // 小屏默认折叠右栏
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    setInitialized(true);
    if (window.innerWidth < 1100 && !workspacePanelCollapsed) {
      useUIStore.getState().toggleWorkspacePanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized]);

  return (
    <div
      style={{
        height: "100dvh", // 铺满视口（#root 高度链的独立兜底）
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <WorkbenchHeader />

      {/* 三栏 */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左侧：Workspace + Sessions */}
        <aside
          style={{
            width: sidebarCollapsed ? 36 : SIDEBAR_WIDTH,
            borderRight: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            transition: "width .18s ease",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {sidebarCollapsed ? (
            <Tooltip title="展开侧边栏" placement="right">
              <button type="button" onClick={toggleSidebar} style={iconButtonStyle}>
                <MenuUnfoldOutlined />
              </button>
            </Tooltip>
          ) : (
            <>
              <PanelToggleBar leftIcon={<MenuFoldOutlined />} onToggle={toggleSidebar} />
              <div style={{ flex: 1, minHeight: 0 }}>
                <WorkspaceSidebar />
              </div>
            </>
          )}
        </aside>

        {/* 中间：Agent Chat */}
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, background: "var(--color-bg)" }}>
          {center}
        </main>

        {/* 右侧：Workspace Files + File Viewer（与左侧一致，可折叠为窄条） */}
        <aside
          style={{
            width: workspacePanelCollapsed ? 36 : PANEL_WIDTH,
            borderLeft: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            transition: "width .18s ease",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {workspacePanelCollapsed ? (
            <Tooltip title="展开工作区面板" placement="left">
              <button type="button" onClick={toggleWorkspacePanel} style={iconButtonStyle}>
                <VerticalLeftOutlined />
              </button>
            </Tooltip>
          ) : (
            <>
              <PanelToggleBar
                leftIcon={<VerticalRightOutlined />}
                onToggle={toggleWorkspacePanel}
                align="left"
              />
              <div
                style={{
                  flex: "0 0 46%",
                  minHeight: 160,
                  borderBottom: "1px solid var(--color-border)",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <WorkspaceExplorer />
              </div>
              <div style={{ flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
                <FileViewer />
              </div>
            </>
          )}
        </aside>
      </div>

      <SettingsModal />
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "var(--color-text-secondary)",
  cursor: "pointer",
};

/** 面板顶部的折叠切换条（align: right 贴右端，left 贴左端 —— 保持视觉对称） */
function PanelToggleBar({
  leftIcon,
  rightIcon,
  onToggle,
  align = "right",
}: {
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  onToggle: () => void;
  align?: "left" | "right";
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 34,
        padding: "0 8px",
        borderBottom: "1px solid var(--color-border)",
        justifyContent: align === "left" ? "flex-start" : "flex-end",
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{ ...iconButtonStyle, width: 26, height: 26 }}
        title="折叠面板"
      >
        {leftIcon ?? rightIcon}
      </button>
    </div>
  );
}
