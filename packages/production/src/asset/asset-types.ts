/**
 * Production Asset 类型（文档 §7）。
 *
 * 所有媒体统一管理：image / video / audio / document / subtitle / reference。
 * AI 生成内容必须可追踪来源（generation：供应商/模型/提示词/任务）。
 */
export type AssetType = "image" | "video" | "audio" | "document" | "subtitle" | "reference";

/** AI 生成追踪信息（文档 §7） */
export interface AssetGeneration {
  providerId: string;
  modelId?: string;
  prompt?: string;
  taskId?: string;
}

export interface ProductionAsset {
  id: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  type: AssetType;
  name: string;
  /** 远程 URL（V0.2 生成结果直接存供应商 URL，不做本地二进制） */
  url?: string;
  /** 工作区内相对路径（文本类资产可落盘到 workspace） */
  workspacePath?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  generation?: AssetGeneration;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入（workspaceId/userId 由 Service 依据项目行推导） */
export interface CreateAssetInput {
  projectId: string;
  type: AssetType;
  name: string;
  url?: string;
  workspacePath?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  generation?: AssetGeneration;
}
