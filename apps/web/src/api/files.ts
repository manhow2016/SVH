import { get, put, post, del } from "./client";
import type { FileContent, FileEntry } from "../types/api-types";

export const fileApi = {
  list: (workspaceId: string, path: string = ".") =>
    get<FileEntry[]>(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path === "" ? "." : path)}`,
    ),
  read: (workspaceId: string, path: string) =>
    get<FileContent>(
      `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
    ),
  write: (workspaceId: string, path: string, content: string) =>
    put<{ path: string }>(`/api/workspaces/${workspaceId}/files`, { path, content }),
  /** 创建目录（可选一级子目录，如资产分类） */
  mkdir: (workspaceId: string, path: string, children: string[] = []) =>
    post<{ path: string }>(`/api/workspaces/${workspaceId}/files/mkdir`, { path, children }),
  remove: (workspaceId: string, path: string) =>
    del<{ path: string }>(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`),
};
