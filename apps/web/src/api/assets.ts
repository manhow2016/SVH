import { get, post, patch, del } from "./client";
import type { FileEntry } from "../types/api-types";

/** 全局资产库 API（跨工作区共享的角色/场景/道具/音色资源） */
export const assetsApi = {
  /** path 缺省为根（资源文件夹列表）；也可传 "文件夹/类型" 查看资产内容 */
  list: (path: string = ".") =>
    get<FileEntry[]>(`/api/assets?path=${encodeURIComponent(path === "" ? "." : path)}`),
  create: (name: string) => post<{ path: string }>("/api/assets", { name }),
  /** 上传资产文件（文本类资源；path 如 "文件夹/类型/文件名"） */
  upload: (path: string, content: string) =>
    post<{ path: string }>("/api/assets/file", { path, content }),
  rename: (name: string, newName: string) =>
    patch<{ path: string }>("/api/assets", { name, newName }),
  remove: (name: string) =>
    del<{ path: string }>(`/api/assets?name=${encodeURIComponent(name)}`),
};
