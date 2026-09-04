import { create } from "zustand";

/**
 * Workspace UI State（文档 §42）。
 * 注意：workspaceList 等 Server 数据由 TanStack Query 管理，store 只存 UI 状态。
 */
interface WorkspaceUIState {
  currentWorkspaceId: string | null;
  /** 文件查看器当前选中的文件路径 */
  selectedFilePath: string | null;
  setCurrentWorkspaceId: (id: string | null) => void;
  setSelectedFilePath: (path: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceUIState>((set) => ({
  currentWorkspaceId: null,
  selectedFilePath: null,
  setCurrentWorkspaceId: (id) => set({ currentWorkspaceId: id, selectedFilePath: null }),
  setSelectedFilePath: (path) => set({ selectedFilePath: path }),
}));
