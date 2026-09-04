import { create } from "zustand";

/**
 * UI 全局状态（文档 §42）。
 *
 * filesRevision：Workspace Explorer 据此重新拉取文件（workspace.changed 事件触发）。
 */
interface UIState {
  sidebarCollapsed: boolean;
  /** 右侧工作区面板（文件树 + 查看器）完全隐藏 */
  workspacePanelHidden: boolean;
  settingsOpen: boolean;
  filesRevision: number;
  /** 递增信号：请求打开「新建 Workspace」弹窗 */
  createWorkspaceSignal: number;
  toggleSidebar: () => void;
  toggleWorkspacePanelHidden: () => void;
  setSettingsOpen: (open: boolean) => void;
  bumpFilesRevision: () => void;
  triggerCreateWorkspace: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  workspacePanelHidden: false,
  settingsOpen: false,
  filesRevision: 0,
  createWorkspaceSignal: 0,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleWorkspacePanelHidden: () =>
    set((state) => ({ workspacePanelHidden: !state.workspacePanelHidden })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  bumpFilesRevision: () => set((state) => ({ filesRevision: state.filesRevision + 1 })),
  triggerCreateWorkspace: () =>
    set((state) => ({ createWorkspaceSignal: state.createWorkspaceSignal + 1 })),
}));
