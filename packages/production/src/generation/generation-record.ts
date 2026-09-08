/**
 * Generation Record 领域规则（V0.3 Phase 5）。
 *
 * 校验与审核状态机。审核动作与任务状态分离：
 * - 仅当生成已完成（status=completed 且已有产出资产）才允许审核（approve/reject）；
 * - approve → reviewStatus=approved + selected=true；
 * - reject → reviewStatus=rejected（保留记录与资产，不覆盖）；
 * - replace → reviewStatus=replaced + selected=true + outputAssetId 替换。
 */
import type { GenerationRecordStatus, GenerationRecord, GenerationReviewStatus } from "./generation-record-types";
import { validationError, conflictError } from "../errors";

const REVIEW_STATUSES: readonly GenerationReviewStatus[] = [
  "pending",
  "generating",
  "generated",
  "reviewing",
  "approved",
  "rejected",
  "replaced",
];
const RECORD_STATUSES: readonly GenerationRecordStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
];

export function isGenerationReviewStatus(v: unknown): v is GenerationReviewStatus {
  return typeof v === "string" && (REVIEW_STATUSES as readonly string[]).includes(v);
}
export function isGenerationRecordStatus(v: unknown): v is GenerationRecordStatus {
  return typeof v === "string" && (RECORD_STATUSES as readonly string[]).includes(v);
}
export function assertGenerationReviewStatus(v: unknown): GenerationReviewStatus {
  if (!isGenerationReviewStatus(v)) throw validationError("生成审核状态不合法");
  return v;
}
export function assertGenerationRecordStatus(v: unknown): GenerationRecordStatus {
  if (!isGenerationRecordStatus(v)) throw validationError("生成记录状态不合法");
  return v;
}

/** 是否可审核：生成已完成且已有产出资产 */
export function canReviewRecord(record: Pick<GenerationRecord, "status" | "outputAssetId">): boolean {
  return record.status === "completed" && Boolean(record.outputAssetId);
}

/** 审核：approve → approved + selected；reject → rejected（保留记录） */
export function applyApprove(record: GenerationRecord): Pick<GenerationRecord, "reviewStatus" | "selected"> {
  if (!canReviewRecord(record)) {
    throw conflictError("仅已完成的生成可审核通过");
  }
  return { reviewStatus: "approved", selected: true };
}

export function applyReject(record: GenerationRecord): Pick<GenerationRecord, "reviewStatus" | "selected"> {
  if (!canReviewRecord(record)) {
    throw conflictError("仅已完成的生成可拒绝");
  }
  return { reviewStatus: "rejected", selected: false };
}

/** 替换：指定新产出资产，标记 replaced + selected */
export function applyReplace(
  outputAssetId: string,
): Pick<GenerationRecord, "reviewStatus" | "selected" | "outputAssetId"> {
  return { reviewStatus: "replaced", outputAssetId, selected: true };
}
