/**
 * 字幕节点执行器核心测试（subtitle.generate，Phase C）：本地 SRT 生成，无模型依赖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSubtitleNode, type SubtitleNodeDeps } from "./subtitle-node";
import type { WorkflowNode } from "@svh/core";

const NODE: WorkflowNode = {
  id: "subtitle",
  type: "subtitle.generate",
  name: "生成字幕",
  dependsOn: ["audio"],
  status: "pending",
  retryCount: 0,
  maxRetries: 1,
};

test("按分镜生成 SRT：时间轴按镜头累计，对白逐条成 cue，落 subtitle 资产", async () => {
  const created: Array<{ name: string; srt: string }> = [];
  const deps: SubtitleNodeDeps = {
    listStoryboards: async () => [{ id: "sto_1", order: 0 }],
    listShotsByStoryboard: async () => [
      { order: 0, dialogue: "开场", duration: 3 },
      { order: 1, dialogue: null, duration: 2 },
      { order: 2, dialogue: "再见", duration: 2 },
    ],
    createSubtitleAsset: async (i) => {
      created.push({ name: i.name, srt: i.srt });
      return { id: "sub_" + created.length };
    },
  };
  const out = await runSubtitleNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: {},
    deps,
  });
  assert.equal(out.assetIds.length, 1);
  assert.equal(out.shots, 2);
  assert.equal(created[0]!.name, "分镜1·字幕");
  // 时间轴：开场 0-3s；中途空镜头 2s 无 cue；再见 5-7s（3+2=5 起）
  const srt = created[0]!.srt;
  assert.ok(srt.includes("00:00:00,000 --> 00:00:03,000\n开场"), "首个 cue 时间码应正确");
  assert.ok(srt.includes("00:00:05,000 --> 00:00:07,000\n再见"), "第二个 cue 应按累计时长起算");
});

test("无对白镜头 → 空输出，不抛错", async () => {
  const deps: SubtitleNodeDeps = {
    listStoryboards: async () => [{ id: "sto_1", order: 0 }],
    listShotsByStoryboard: async () => [{ order: 0, dialogue: null, duration: 3 }],
    createSubtitleAsset: async () => ({ id: "x" }),
  };
  const out = await runSubtitleNode({
    ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" },
    node: NODE,
    input: {},
    deps,
  });
  assert.deepEqual(out, { assetIds: [], shots: 0 });
});
