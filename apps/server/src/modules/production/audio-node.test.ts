/**
 * 配音节点执行器核心测试（audio.generate，Phase C 简化版）。
 *
 * 假 deps：带对白镜头 → 逐个入队（音色取场景首角色）→ 等待终态 → completed 绑定
 * shot.audioAssetId；无对白镜头跳过；收养既有任务不重复入队。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAudioNode, type AudioNodeDeps } from "./audio-node";
import type { WorkflowNode } from "@svh/core";

const NODE: WorkflowNode = {
  id: "audio",
  type: "audio.generate",
  name: "镜头配音",
  dependsOn: ["review"],
  status: "pending",
  retryCount: 0,
  maxRetries: 1,
};

const SHOTS = {
  sto_1: [
    { id: "sho_1", dialogue: "你好，我是主角", duration: 3 },
    { id: "sho_2", dialogue: "   ", duration: 2 },
    { id: "sho_3", dialogue: "再见", duration: 2 },
  ],
};

function makeDeps(overrides: Partial<AudioNodeDeps> = {}): AudioNodeDeps {
  const taskStatus = new Map<string, string>();
  const enqueued: Array<{ prompt: string; voice?: string; storyboardId: string }> = [];
  const bound: Array<{ shotId: string; audioAssetId: string }> = [];
  const deps: AudioNodeDeps = {
    pollMs: 5,
    maxWaitMs: 500,
    listStoryboards: async () => [
      { id: "sto_1", sceneId: "scn_1", order: 0 },
      { id: "sto_2", sceneId: "scn_2", order: 1 },
    ],
    listShotsByStoryboard: async (sid) =>
      sid === "sto_1" ? SHOTS.sto_1 : [{ id: "sho_9", dialogue: null, duration: 3 }],
    resolveSceneVoice: async (sceneId) => (sceneId === "scn_1" ? "Cherry" : undefined),
    enqueueAudio: async (i) => {
      enqueued.push({ prompt: i.prompt, voice: i.voice, storyboardId: i.storyboardId });
      const id = "ptk_" + enqueued.length;
      taskStatus.set(id, "completed"); // 秒回
      return { id };
    },
    getTask: async (id) => ({ id, status: taskStatus.get(id) ?? "completed" }),
    findAssetByTask: async (taskId) => ({ id: "ast_" + taskId }),
    updateShotAudio: async (shotId, audioAssetId) => {
      bound.push({ shotId, audioAssetId });
    },
    listTasksByNode: () => [],
    ...overrides,
  };
  // 测试可读回执
  return Object.assign(deps, { __enqueued: enqueued, __bound: bound });
}

test("配音节点带对白镜头入队并绑定（音色取场景首角色 voice），无对白跳过", async () => {
  const deps = makeDeps() as AudioNodeDeps & { __enqueued: Array<unknown>; __bound: Array<unknown> };
  const out = await runAudioNode({ ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" }, node: NODE, input: {}, deps });
  // sto_1：sho_1（配音，voice=Cherry）、sho_2（空白跳过）、sho_3（配音，voice=Cherry）；sto_2 无对白
  assert.equal(deps.__enqueued.length, 2, "两条对白应入队");
  assert.equal((deps.__enqueued[0] as { prompt: string }).prompt, "你好，我是主角");
  assert.equal((deps.__enqueued[0] as { voice?: string }).voice, "Cherry");
  assert.equal(deps.__bound.length, 2, "两个镜头应绑定音频资产");
  assert.deepEqual(
    deps.__bound.map((b) => (b as { shotId: string }).shotId).sort(),
    ["sho_1", "sho_3"],
  );
  assert.equal(out.summary.succeeded, 2);
  assert.equal(out.summary.skipped, 2); // sho_2 空白对白 + sto_2 无对白镜头
  assert.equal(out.items["sho_2"]?.status, "skipped");
});


test("配音节点收养既有任务：不重复入队，等待既有任务终态后绑定", async () => {
  let enqueuedCount = 0;
  const bound: Array<{ shotId: string }> = [];
  const deps: AudioNodeDeps = {
    pollMs: 5,
    maxWaitMs: 500,
    listStoryboards: async () => [{ id: "sto_1", sceneId: "scn_1", order: 0 }],
    listShotsByStoryboard: async () => SHOTS.sto_1,
    resolveSceneVoice: async () => "Cherry",
    enqueueAudio: async () => {
      enqueuedCount += 1;
      throw new Error("不应入队");
    },
    // 既有任务 ptk_adopt 在首轮 running、次轮 completed（模拟 worker 秒完）
    getTask: async (id) => ({ id, status: "completed" }),
    findAssetByTask: async (taskId) => ({ id: "ast_" + taskId }),
    updateShotAudio: async (shotId) => {
      bound.push({ shotId });
    },
    listTasksByNode: () => [{ id: "ptk_adopt", status: "running", storyboardId: "sto_1" }],
  };
  const out = await runAudioNode({ ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" }, node: NODE, input: {}, deps });
  assert.equal(enqueuedCount, 0, "收养任务不应重复入队");
  // sto_1 两条带对白镜头（sho_1/sho_3）按既有任务绑定
  assert.deepEqual(bound.map((b) => b.shotId).sort(), ["sho_1", "sho_3"]);
  assert.equal(out.summary.succeeded, 2);
});
