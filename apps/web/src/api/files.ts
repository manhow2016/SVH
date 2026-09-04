import { get, put, del } from "./client";
import type { FileContent, FileEntry } from "../types/api-types";

export const fileApi = {
  list: (workspaceId: string, path = ".") =>
    get<FileEntry[]>(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`),
  read: (workspaceId: string, path: string) =>
    get<FileContent>(
      `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
    ),
  write: (workspaceId: string, path: string, content: string) =>
    put<{ path: string }>(`/api/workspaces/${workspaceId}/files`, { path, content }),
  remove: (workspaceId: string, path: string) =>
    del<{ path: string }>(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`),
};
