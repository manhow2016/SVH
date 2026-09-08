import { create } from "zustand";

/**
 * UI 全局状态（V0.3 布局重构后精简）。
 *
 * filesRevision：文件刷新信号（Agent 修改工作区文件后递增，供仍引用文件视图的组件重拉）。
 * settingsOpen：设置弹窗开关（左侧会话栏底部入口）。
 */
interface UIState {
  settingsOpen: boolean;
  filesRevision: number;
  setSettingsOpen: (open: boolean) => void;
  bumpFilesRevision: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  settingsOpen: false,
  filesRevision: 0,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  bumpFilesRevision: () => set((state) => ({ filesRevision: state.filesRevision + 1 })),
}));
