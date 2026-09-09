import { create } from "zustand";

/**
 * UI 全局状态（V0.3 布局重构后精简）。
 *
 * filesRevision：文件刷新信号（Agent 修改工作区文件后递增，供仍引用文件视图的组件重拉）。
 */
interface UIState {
  filesRevision: number;
  bumpFilesRevision: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  filesRevision: 0,
  bumpFilesRevision: () => set((state) => ({ filesRevision: state.filesRevision + 1 })),
}));
