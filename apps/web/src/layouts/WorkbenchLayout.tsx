import { useEffect, useState, type ReactNode } from "react";
import { Tooltip } from "antd";
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  VerticalLeftOutlined,
  VerticalRightOutlined,
} from "@ant-design/icons";
import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import { SessionSidebar } from "../features/session/SessionSidebar";
import { WorkspaceExplorer } from "../features/workspace/WorkspaceExplorer";
import { FileViewer } from "../features/workspace/FileViewer";
import { SettingsDrawer } from "../features/settings/SettingsDrawer";
import { useUIStore } from "../stores/ui-store";
import { useSessionStore } from "../stores/session-store";
import { useWorkspaceStore } from "../stores/workspace-store";

const SIDEBAR_WIDTH = 232;
const PANEL_WIDTH = 320;

/**
 * WorkbenchLayout（文档 §33、§34）：
 * Header + 三栏（Sessions / Agent Chat / Workspace）+ Status Bar。
 */
export function WorkbenchLayout({ center }: { center: ReactNode }) {
  const { sidebarCollapsed, workspacePanelCollapsed, toggleSidebar, toggleWorkspacePanel } =
    useUIStore();
  const isRunning = useSessionStore((s) => s.isRunning);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  // 小屏默认收起右栏
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
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <WorkbenchHeader />

      {/* 三栏 */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左侧：Sessions */}
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
          }}
        >
          {sidebarCollapsed ? (
            <Tooltip title="展开会话列表" placement="right">
              <button type="button" onClick={toggleSidebar} style={iconButtonStyle}>
                <MenuUnfoldOutlined />
              </button>
            </Tooltip>
          ) : (
            <>
              <PanelToggleBar leftIcon={<MenuFoldOutlined />} onToggle={toggleSidebar} />
              <div style={{ flex: 1, minHeight: 0 }}>
                <SessionSidebar />
              </div>
            </>
          )}
        </aside>

        {/* 中间：Agent Chat */}
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, background: "var(--color-bg)" }}>
          {center}
        </main>

        {/* 右侧：Workspace */}
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
                rightIcon={<VerticalRightOutlined />}
                onToggle={toggleWorkspacePanel}
              />
              <div
                style={{
                  height: "44%",
                  minHeight: 160,
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                <WorkspaceExplorer />
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <FileViewer />
              </div>
            </>
          )}
        </aside>
      </div>

      {/* Status Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 26,
          padding: "0 12px",
          borderTop: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          fontSize: 11.5,
          color: "var(--color-text-tertiary)",
          flexShrink: 0,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: isRunning ? "var(--color-warning)" : "var(--color-success)",
            }}
          />
          {isRunning ? "Running…" : "Ready"}
        </span>
        <span style={{ flex: 1 }} />
        {currentWorkspaceId && <span>Workspace: {currentWorkspaceId}</span>}
        <span>Context: VIDEO_AGENTS.md + 最近 50 条消息</span>
      </div>

      <SettingsDrawer />
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

/** 面板顶部的折叠切换条 */
function PanelToggleBar({
  leftIcon,
  rightIcon,
  onToggle,
}: {
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        padding: "0 8px",
        borderBottom: "1px solid var(--color-border)",
        justifyContent: "flex-end",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{ ...iconButtonStyle, width: 28, height: 28 }}
        title="折叠面板"
      >
        {leftIcon ?? rightIcon}
      </button>
    </div>
  );
}
