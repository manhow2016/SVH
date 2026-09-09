import { get, post } from "./client";
import type { FileEntry, AssetType } from "../types/api-types";

/** 全局资产库 API（跨工作区共享的角色/场景/道具/音色资源） */
export const assetsApi = {
  // --- 旧版文件系统 API（兼容现有文件夹管理） ---
  /** path 缺省为根（资源文件夹列表）；也可传 "文件夹/类型" 查看资产内容 */
  list: (path: string = ".") =>
    get<FileEntry[]>(`/api/assets?path=${encodeURIComponent(path === "" ? "." : path)}`),
  create: (name: string) => post<{ path: string }>("/api/assets", { name }),
  /** 上传资产文件（文本类资源；path 如 "文件夹/类型/文件名"） */
  upload: (path: string, content: string) =>
    post<{ path: string }>("/api/assets/file", { path, content }),
  rename: (name: string, newName: string) =>
    fetch(`/api/assets`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, newName }),
    }).then(r => r.json()),
  remove: (name: string) =>
    fetch(`/api/assets?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then(r => r.json()),

  // --- 新版 AI 生成 API ---
  /** 获取各类资产数量汇总（用于卡片展示） */
  counts: () =>
    get<Record<string, number>>("/api/assets/counts"),

  /** 生成资产（统一入口） */
  generate: (body: AssetGenerateRequest) =>
    post<AssetGenerationResult>("/api/assets/generate", body),
};

// ------------------------------------------------------------------
// 类型定义（复用 api-types，此文件仅作扩展注释）
// ------------------------------------------------------------------
import type { AssetGenerateRequest, AssetGenerationResult } from "../types/api-types";
