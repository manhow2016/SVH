/**
 * 审核节点执行器核心测试（review.generation）。
 *
 * 用假 deps（端口注入面）验证裁定逻辑：
 * - 无生成任务（0 扇出 / 无生成节点）→ 直接通过
 * - 全部已裁定（approved/replaced/rejected）→ 节点输出裁定结果（decision）
 * - 存在未裁定（pending 等 / 记录缺失）→ 等待哨兵 { __waitForUser: true }
 * - 仅评审生成节点判为 completed 的项（failed/cancelled/timeout/skipped 不阻塞）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReviewNode, type ReviewNodeDeps } from "./review-node";
import type { WorkflowNode } from "@svh/core";

const NODE = {
  id: "review",
  type: "review.generation",
  name: "人工审核",
  dependsOn: ["videos"],
  status: "pending",
  retryCount: 0,
  maxRetries: 1,
} as WorkflowNode;

/** items 构造器：storyboardId → { status, taskId } */
function itemsFrom(entries: Array<[string, string, string | null]>): Record<string, { status: string; taskId: string | null }> {
  const items: Record<string, { status: string; taskId: string | null }> = {};
  for (const [id, status, taskId] of entries) {
    items[id] = { status, taskId };
  }
  return items;
}

function depsOf(map: Record<string, string | null>): ReviewNodeDeps {
  return {
    async findRecordReviewStatus(taskId: string) {
      return map[taskId] ?? null;
    },
  };
}

test("无生成任务（items 为空）→ 直接通过 approved total=0", async () => {
  const out = (await runReviewNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: { items: {} },
    deps: depsOf({}),
  })) as { decision: string; total: number };
  assert.equal(out.decision, "approved");
  assert.equal(out.total, 0);
});

test("全部已通过（approved）→ decision=approved", async () => {
  const out = (await runReviewNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: { items: itemsFrom([["sto_1", "completed", "ptk_1"], ["sto_2", "completed", "ptk_2"]]) },
    deps: depsOf({ ptk_1: "approved", ptk_2: "approved" }),
  })) as { decision: string; approved: number; rejected: number; total: number };
  assert.equal(out.decision, "approved");
  assert.equal(out.approved, 2);
  assert.equal(out.rejected, 0);
  assert.equal(out.total, 2);
});

test("存在拒绝（rejected）→ decision=rejected，approved 计数正确", async () => {
  const out = (await runReviewNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: { items: itemsFrom([["sto_1", "completed", "ptk_1"], ["sto_2", "completed", "ptk_2"]]) },
    deps: depsOf({ ptk_1: "approved", ptk_2: "rejected" }),
  })) as { decision: string; rejected: number; total: number };
  assert.equal(out.decision, "rejected");
  assert.equal(out.rejected, 1);
  assert.equal(out.total, 2);
});

test("replaced 视为已裁定（满意侧），不等待", async () => {
  const out = (await runReviewNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: { items: itemsFrom([["sto_1", "completed", "ptk_1"]]) },
    deps: depsOf({ ptk_1: "replaced" }),
  })) as { decision: string; replaced: number };
  assert.equal(out.decision, "approved");
  assert.equal(out.replaced, 1);
});

test("存在未裁定（pending / 记录缺失）→ 等待哨兵 __waitForUser", async () => {
  const waiting = (await runReviewNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: { items: itemsFrom([["sto_1", "completed", "ptk_1"], ["sto_2", "completed", "ptk_2"]]) },
    deps: depsOf({ ptk_1: "approved" }), // ptk_2 缺失 → 等待
  })) as { __waitForUser?: boolean };
  assert.equal(waiting.__waitForUser, true);

  const missingAll = (await runReviewNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: { items: itemsFrom([["sto_1", "completed", "ptk_x"]]) },
    deps: depsOf({}),
  })) as { __waitForUser?: boolean };
  assert.equal(missingAll.__waitForUser, true);
});

test("仅评审 completed 项：failed/cancelled 项不阻塞", async () => {
  const out = (await runReviewNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: {
      items: itemsFrom([
        ["sto_1", "completed", "ptk_1"],
        ["sto_2", "failed", "ptk_2"],
        ["sto_3", "cancelled", "ptk_3"],
      ]),
    },
    deps: depsOf({ ptk_1: "approved" }), // failed/cancelled 的记录不在评审范围
  })) as { decision: string; total: number };
  assert.equal(out.decision, "approved");
  assert.equal(out.total, 1);
});
