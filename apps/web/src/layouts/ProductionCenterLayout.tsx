import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  VerticalLeftOutlined,
  VerticalRightOutlined,
} from "@ant-design/icons";
import { Tooltip } from "antd";
import { WorkbenchHeader } from "../features/header/WorkbenchHeader";
import { SessionList } from "../features/sidebar/SessionList";
import { AgentChat } from "../features/chat/AgentChat";
import { sessionApi } from "../api/session";
import { useSessionStore } from "../stores/session-store";

const SIDEBAR_WIDTH = 280;
const CHAT_WIDTH = 360;

/**
 * 制作中心主布局（V0.3 布局重构）：
 * 顶部全局标签栏 + 左（会话列表 + 页面底部插槽，如制作导航）+ 中（内容）+ 右（Agent 对话）。
 * 工作区概念从 UI 隐藏（SessionList 内自动绑定第一个工作区）；文件面板已移除。
 */
export function ProductionCenterLayout({
  leftBottom,
  center,
}: {
  /** 左侧边栏下段（详情页放模块导航；列表页可空） */
  leftBottom?: ReactNode;
  center: ReactNode;
}) {
  const { currentSessionId } = useSessionStore();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);

  // 小屏默认折叠右栏
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    setInitialized(true);
    if (window.innerWidth < 1100) setChatCollapsed(true);
  }, [initialized]);

  const { data: currentSession } = useQuery({
    queryKey: ["session", currentSessionId],
    queryFn: () => sessionApi.get(currentSessionId!),
    enabled: !!currentSessionId,
  });

  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <WorkbenchHeader />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左侧：会话 + 底部插槽 */}
        <aside
          style={{
            width: leftCollapsed ? 36 : SIDEBAR_WIDTH,
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
          {leftCollapsed ? (
            <Tooltip title="展开侧边栏" placement="right">
              <button type="button" onClick={() => setLeftCollapsed(false)} style={iconButtonStyle}>
                <MenuUnfoldOutlined />
              </button>
            </Tooltip>
          ) : (
            <>
              <div style={{ height: 34, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 8px", borderBottom: "1px solid var(--color-border)" }}>
                <button type="button" title="折叠侧边栏" onClick={() => setLeftCollapsed(true)} style={{ ...iconButtonStyle, width: 26, height: 26 }}>
                  <MenuFoldOutlined />
                </button>
              </div>
              <div
                style={{
                  flex: "0 0 48%",
                  minHeight: 200,
                  borderBottom: "1px solid var(--color-border)",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <SessionList />
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>{leftBottom}</div>
            </>
          )}
        </aside>

        {/* 中间：页面内容 */}
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, background: "var(--color-bg)", overflow: "hidden" }}>
          {center}
        </main>

        {/* 右侧：Agent 对话（替代原文件面板） */}
        <aside
          style={{
            width: chatCollapsed ? 36 : CHAT_WIDTH,
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
          {chatCollapsed ? (
            <Tooltip title="展开对话" placement="left">
              <button type="button" onClick={() => setChatCollapsed(false)} style={iconButtonStyle}>
                <VerticalLeftOutlined />
              </button>
            </Tooltip>
          ) : (
            <>
              <div style={{ height: 34, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 8px", borderBottom: "1px solid var(--color-border)" }}>
                <button type="button" title="折叠对话" onClick={() => setChatCollapsed(true)} style={{ ...iconButtonStyle, width: 26, height: 26 }}>
                  <VerticalRightOutlined />
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                {currentSession ? (
                  <AgentChat session={currentSession} />
                ) : (
                  <div
                    style={{
                      height: "100%",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      color: "var(--color-text-tertiary)",
                    }}
                  >
                    <MessageOutlined style={{ fontSize: 28 }} />
                    <div style={{ fontSize: 13, fontWeight: 600 }}>选择一个会话</div>
                    <div style={{ fontSize: 12, maxWidth: 260, textAlign: "center" }}>
                      在左侧选择或新建会话，向 Agent 描述任务
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "var(--color-text-secondary)",
  cursor: "pointer",
};
