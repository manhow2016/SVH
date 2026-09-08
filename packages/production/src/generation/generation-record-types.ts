/**
 * Generation Review 类型（V0.3 Phase 5，实施文档 §27/§29/§30/§39）。
 *
 * `GenerationRecord` 是「一次生成」的记录：记录 provider/model/prompt/negative/
 * 输入参考/taskId/输出资产/状态/审核状态/版本，供 Review / Regenerate / Replay /
 * Debug 使用。与 `production_tasks`（执行状态）分离：本表专管**生成历史 + 审核**。
 *
 * 保留所有旧生成（禁止覆盖）：同一 Shot 可有多条记录（v1/v2/v3…），
 * 最终「选中资产」由 `selected=true` + shot 的 imageAssetId/videoAssetId 表达。
 */

/** 生成生命周期状态（镜像 production_tasks 终态，便于直接展示） */
export type GenerationRecordStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** 审核状态（与任务状态分离，实施文档 §27） */
export type GenerationReviewStatus =
  | "pending" // 已入队未生成
  | "generating" // 正在生成
  | "generated" // 已生成待审核
  | "reviewing" // 审核中
  | "approved" // 通过
  | "rejected" // 拒绝
  | "replaced"; // 已替换为其它资产

export type GenerationKind = "image" | "video" | "audio";

/** 输入参考（图生视频首帧等） */
export interface GenerationInputRef {
  imageUrl?: string;
}

export interface GenerationRecord {
  id: string;
  projectId: string;
  /** 关联镜头（production_shots.id，可选；有则参与版本号与选中资产） */
  shotId?: string;
  /** 关联分镜（production_storyboards.id，可选，扇出绑定用） */
  storyboardId?: string;
  kind: GenerationKind;
  /** 版本号（同一 shot 内从 1 递增；无 shotId 时恒为 1） */
  version: number;
  providerId?: string;
  modelId?: string;
  /** 最终组合提示词 */
  prompt: string;
  negativePrompt?: string;
  promptMetadata?: Record<string, unknown>;
  inputRef?: GenerationInputRef;
  /** 关联的生成任务（production_tasks.id） */
  taskId?: string;
  /** 产出资产（production_assets.id） */
  outputAssetId?: string;
  /** 任务生命周期状态（镜像） */
  status: GenerationRecordStatus;
  /** 审核状态 */
  reviewStatus: GenerationReviewStatus;
  /** 是否为该镜头当前选中的资产（approve/replace 后 true） */
  selected: boolean;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入（version 由 Service 依 shot 计算） */
export interface CreateGenerationRecordInput {
  projectId: string;
  shotId?: string;
  storyboardId?: string;
  kind: GenerationKind;
  prompt: string;
  negativePrompt?: string;
  promptMetadata?: Record<string, unknown>;
  inputRef?: GenerationInputRef;
  providerId?: string;
  modelId?: string;
  taskId?: string;
}

/** 更新输入 */
export type UpdateGenerationRecordInput = Partial<
  Pick<
    GenerationRecord,
    | "status"
    | "reviewStatus"
    | "selected"
    | "outputAssetId"
    | "taskId"
    | "error"
  >
>;

/** 计算下一版本号（同 shot 内 max+1；无 shotId 恒为 1） */
export function nextGenerationVersion(records: Pick<GenerationRecord, "shotId" | "version">[]): number {
  if (records.length === 0) return 1;
  const max = records.reduce((m, r) => Math.max(m, r.version), 0);
  return max + 1;
}
