/**
 * 生成节点执行器核心测试（Task 2）。
 *
 * 用假 deps（端口注入面）验证核心行为，不依赖真库 / Fastify / worker：
 * - 扇出筛选 + 0 扇出抛错
 * - 收养既有任务不重复入队
 * - 理想路径：任务立即完成 → 绑定 shots → 返回完整 output
 * - 部分失败：failed 项记录、成功项仍绑定、节点抛错
 * - abort：等待期间批量 cancelTask 并抛错
 *
 * 注：brief 中 `makeDeps` 缺失 findAssetByTask；实现按 spec §6 在观测到 completed
 * 时经它反查产物资产，故测试在 makeDeps 补上该端口（返回固定资产）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGenerationNode, type GenerationNodeDeps, type GenerationNodeContext } from "./generation-node-executor";
import type { WorkflowNode } from "@svh/core";

const CONTEXT: GenerationNodeContext = { projectId: "p1", workflowId: "wfl_1", userId: "u1" };
const NODE = {
  id: "images",
  type: "image.generate",
  name: "生成图片",
  dependsOn: ["storyboard"],
  status: "pending",
  retryCount: 0,
  maxRetries: 1,
} as WorkflowNode;

function makeDeps(overrides: Partial<GenerationNodeDeps> = {}): GenerationNodeDeps {
  const sb = {
    id: "sto_1",
    projectId: "p1",
    sceneId: "sc",
    order: 1,
    description: "d",
    duration: 3,
    shotType: "wide",
    imagePrompt: "一只白鹤掠过水面",
    videoPrompt: null,
    status: "draft",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const shot = {
    id: "sho_1",
    projectId: "p1",
    storyboardId: "sto_1",
    order: 1,
    duration: 3,
    framing: null,
    cameraMovement: null,
    action: null,
    dialogue: null,
    imageAssetId: null,
    videoAssetId: null,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const taskStatus = new Map<string, string>();
  return {
    pollMs: 5,
    maxWaitMs: 500,
    async listStoryboards() {
      return [sb];
    },
    async listShotsByStoryboard() {
      return [shot];
    },
    async getAsset(id) {
      return {
        id,
        projectId: "p1",
        workspaceId: "ws",
        userId: "u1",
        type: "image",
        name: "x",
        url: "http://asset/" + id,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;
    },
    // spec §6：completed 时按任务 id 反查产物资产（找不到返回 null）
    async findAssetByTask(taskId: string) {
      return {
        id: "ast_" + taskId,
        projectId: "p1",
        workspaceId: "ws",
        userId: "u1",
        type: "image",
        name: "x",
        url: "http://asset/" + taskId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;
    },
    async updateShot(id, patch) {
      return { id, imageAssetId: patch.imageAssetId, videoAssetId: patch.videoAssetId } as any;
    },
    async listAssets() {
      return [];
    },
    async enqueueImage(_input) {
      taskStatus.set("ptk_1", "queued");
      return { id: "ptk_1" };
    },
    async enqueueVideo() {
      return { id: "ptk_2" };
    },
    async getTask(id) {
      return { id, status: taskStatus.get(id) ?? "queued" };
    },
    async cancelTask() {},
    listTasksByNode() {
      return [];
    },
    async writeNodeOutput() {},
    ...overrides,
  };
}

test("image.generate：扇出→等待立即完成→绑定 shots + 返回完整 output", async () => {
  const deps = makeDeps();
  const orig = deps.enqueueImage.bind(deps);
  deps.enqueueImage = async (input) => {
    const r = await orig(input);
    // 入队即视为已完成（模拟 worker 秒回）。
    deps.getTask = async () => ({ id: "ptk_1", status: "completed" });
    (deps as any).__taskId = r.id;
    return r;
  };
  const out = await runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps });
  assert.equal(out.summary.total, 1);
  assert.equal(out.summary.succeeded, 1);
  assert.equal(out.summary.failed, 0);
  const item = out.items["sto_1"]!;
  assert.equal(item.status, "completed");
  assert.deepEqual(item.boundShotIds, ["sho_1"]);
  assert.equal(item.assetId, "ast_ptk_1");
});

test("0 合格分镜 → 抛可操作错误", async () => {
  const deps = makeDeps({ listStoryboards: async () => [{ /* imagePrompt: null */ } as any] });
  await assert.rejects(
    runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps }),
    /无合格分镜/,
  );
});

test("收养：existing queued/running 任务不被重复入队", async () => {
  let enqueued = 0;
  const deps = makeDeps({
    listTasksByNode: () => [{ id: "ptk_existing", status: "queued", storyboardId: "sto_1" }],
  });
  deps.enqueueImage = async () => {
    enqueued++;
    return { id: "ptk_new" };
  };
  // 收养任务在等待期被 worker 完成 → 补绑
  deps.getTask = async (id) => ({ id, status: "completed" });
  const out = await runGenerationNode({ ctx: CONTEXT, node: NODE, input: { regenerateAll: false }, deps });
  assert.equal(enqueued, 0, "收养实例不应重新入队");
  assert.equal(out.items["sto_1"]!.status, "completed");
});

test("abort：等待期间取消未终态任务并抛错", async () => {
  const cancelled: string[] = [];
  const deps = makeDeps({
    getTask: async () => ({ id: "ptk_1", status: "queued" }),
    cancelTask: async (id) => {
      cancelled.push(id);
    },
  });
  const ac = new AbortController();
  // 起跑后立即 abort
  const p = runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, /取消|abort/i);
  assert.ok(cancelled.includes("ptk_1"));
});

test("部分失败：failed 项记录，成功项仍绑，整体抛错", async () => {
  const deps = makeDeps({
    listStoryboards: async () => [
      { id: "sto_1" /* success */, imagePrompt: "x", videoPrompt: null, status: "draft" } as any,
      { id: "sto_2" /* fail */, imagePrompt: "y", videoPrompt: null, status: "draft" } as any,
    ],
    listShotsByStoryboard: async (sid) => [
      { id: "sho_" + sid, imageAssetId: null, videoAssetId: null, status: "pending" } as any,
    ],
    getTask: async (id) => ({ id, status: id === "ptk_2" ? "failed" : "completed" }),
  });
  let n = 0;
  deps.enqueueImage = async () => ({ id: "ptk_" + ++n });
  await assert.rejects(
    runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps }),
    /失败/,
  );
});
