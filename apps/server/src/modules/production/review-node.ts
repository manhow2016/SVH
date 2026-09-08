/**
 * 审核节点执行器（review.generation）：生成节点（image/video.generate）完成后的「人类审核」门控。
 *
 * 语义（V0.3 待办：工作流人类审核节点）：
 * - 输入 = 上游生成节点输出 { items: { [storyboardId]: GenItem } }；
 * - 仅评审 status === "completed" 的项（failed/cancelled/timeout/skipped 已在生成节点被判弃，
 *   不参与人工审核）；
 * - 全部已裁定（approved / rejected / replaced）→ 返回裁定结果，节点完成：decision =
 *   rejected 存在 ? "rejected" : "approved"（下游可检查决定决定跳过与否）；
 * - 存在未裁定（pending/generating/generated/reviewing，或记录缺失）→ 返回等待哨兵
 *   { __waitForUser: true }：引擎挂起工作流为 waiting_user，人工审核动作后由服务层 resume
 *   重入本节点重新裁定；
 * - 无任何可审任务（无生成节点 / 0 扇出）→ 直接通过（approved，total=0）。
 */
import { desc, eq } from "drizzle-orm";
import { generationRecords, type SVHDatabase } from "@svh/database";
import type { WorkflowNode } from "@svh/core";

export interface ReviewNodeContext {
  projectId: string;
  workflowId: string;
  userId: string;
}

/** 审核节点依赖端口（注入面）：只声明消费子集——按任务 id 反查生成记录的审核状态 */
export interface ReviewNodeDeps {
  /** 按任务 id 反查生成记录审核状态（无匹配返回 null） */
  findRecordReviewStatus(taskId: string): Promise<string | null>;
}

export interface ReviewNodeOutput {
  decision: "approved" | "rejected";
  approved: number;
  rejected: number;
  /** replaced 视为已裁定（满意侧），单独计数便于展示 */
  replaced: number;
  total: number;
}

export async function runReviewNode(opts: {
  ctx: ReviewNodeContext;
  node: WorkflowNode;
  input: unknown;
  deps: ReviewNodeDeps;
}): Promise<unknown> {
  const { input, deps } = opts;
  const items = (input as { items?: Record<string, { status?: string; taskId?: string | null }> } | undefined)?.items;
  // 仅评审生成节点判为成功的项；失败/取消/超时/跳过项不进入工审核
  const taskIds = Object.values(items ?? {})
    .filter((it) => it?.status === "completed")
    .map((it) => it?.taskId)
    .filter((v): v is string => typeof v === "string" && v !== "");

  if (taskIds.length === 0) {
    // 无生成任务（0 扇出 / 无生成节点）→ 无需审核，直接放行
    return { decision: "approved", approved: 0, rejected: 0, replaced: 0, total: 0 };
  }

  let approved = 0;
  let rejected = 0;
  let replaced = 0;
  let waiting = 0;
  for (const taskId of taskIds) {
    const status = await deps.findRecordReviewStatus(taskId);
    if (status === "approved") approved += 1;
    else if (status === "replaced") replaced += 1;
    else if (status === "rejected") rejected += 1;
    else waiting += 1; // 记录缺失或未裁定 → 继续等待人工审核
  }

  if (waiting > 0) {
    return { __waitForUser: true };
  }
  return {
    decision: rejected > 0 ? "rejected" : "approved",
    approved,
    rejected,
    replaced,
    total: taskIds.length,
  } satisfies ReviewNodeOutput;
}

// ================= 真实装配（app.ts 与集成测试共用） =================

export function createRealReviewDeps(opts: { db: SVHDatabase }): ReviewNodeDeps {
  return {
    async findRecordReviewStatus(taskId: string) {
      const row = opts.db
        .select({ reviewStatus: generationRecords.reviewStatus })
        .from(generationRecords)
        .where(eq(generationRecords.taskId, taskId))
        .orderBy(desc(generationRecords.createdAt), desc(generationRecords.id))
        .get();
      return row?.reviewStatus ?? null;
    },
  };
}
