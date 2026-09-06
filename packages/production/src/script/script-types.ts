/**
 * Production Script 类型（文档 §6.2）。
 *
 * 剧本以版本化文本保存：内容变更时 version+1 并回退为 draft。
 */
export type ScriptStatus = "draft" | "reviewing" | "approved";

export interface ProductionScript {
  id: string;
  projectId: string;
  title: string;
  content: string;
  version: number;
  status: ScriptStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入 */
export interface CreateScriptInput {
  projectId: string;
  title: string;
  content: string;
  status?: ScriptStatus;
}

/** 更新输入（version 由 Service 在内容变更时自动提升，调用方一般不传） */
export type UpdateScriptInput = Partial<
  Pick<ProductionScript, "title" | "content" | "status" | "version">
>;
