/**
 * 成片组装节点执行器核心测试（video.compose）：命令拼装 + 输出/就绪标记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { runComposeNode, type ComposeNodeDeps } from "./compose-node";
import type { WorkflowNode } from "@svh/core";

const NODE: WorkflowNode = {
  id: "compose",
  type: "video.compose",
  name: "成片组装",
  dependsOn: ["subtitle"],
  status: "pending",
  retryCount: 0,
  maxRetries: 0,
};

test("compose：视频段直用 + 图片段转 loop → concat → 标记 ready", async () => {
  const calls: Array<{ args: string[] }> = [];
  let marked: { id: string; wp: string; bytes: number } | undefined;
  const outAbs = join(tmpdir(), "svh-compose-test-out.mp4");
  await writeFile(outAbs, Buffer.from("fake-mp4"));
  const deps: ComposeNodeDeps = {
    listStoryboards: async () => [{ id: "sto_1", order: 0 }],
    listShotsByStoryboard: async () => [
      { order: 0, duration: 3, videoAssetId: "ast_v1" },
      { order: 1, duration: 2, imageAssetId: "ast_img1" },
    ],
    localAssetPath: async (assetId) => (assetId === "ast_v1" ? "/media/seg1.mp4" : "/media/img1.png"),
    createComposedAsset: async () => ({ id: "ast_out", workspaceId: "ws" }),
    prepareOutput: async () => ({ abs: outAbs, workspacePath: "media/ast_out.mp4" }),
    markOutputReady: async (id, wp, bytes) => {
      marked = { id, wp, bytes };
    },
    runFfmpeg: async (args) => {
      calls.push({ args });
    },
    createTempDir: async () => tmpdir(),
    removeDir: async () => {},
  };
  const out = await runComposeNode({ ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" }, node: NODE, input: {}, deps });
  assert.equal(out.assetId, "ast_out");
  assert.equal(out.segments, 2);
  // 图片段转换：-loop 1 + 时长 2s
  const convert = calls[0]!.args;
  assert.ok(convert.includes("-loop") && convert.includes("/media/img1.png") && convert.includes("2"), "图片段应 loop 转换");
  assert.ok(convert.includes("libx264"));
  // concat：-f concat -safe 0 → 输出路径
  const concat = calls[1]!.args;
  assert.ok(concat.includes("-f") && concat.includes("concat") && concat.includes("-safe") && concat.includes(outAbs));
  // ready 标记
  assert.deepEqual(marked, { id: "ast_out", wp: "media/ast_out.mp4", bytes: ("fake-mp4").length });
  assert.equal(out.workspacePath, "media/ast_out.mp4");
});

test("compose：无可用画面段 → 空输出且不抛错", async () => {
  const deps: ComposeNodeDeps = {
    listStoryboards: async () => [{ id: "sto_1", order: 0 }],
    listShotsByStoryboard: async () => [{ order: 0, duration: 3, imageAssetId: "ast_missing" }],
    localAssetPath: async () => null, // 未转存/远程 → 跳过
    createComposedAsset: async () => ({ id: "x", workspaceId: "ws" }),
    prepareOutput: async () => ({ abs: "/tmp/x.mp4", workspacePath: "media/x.mp4" }),
    markOutputReady: async () => {},
    runFfmpeg: async () => {
      throw new Error("不应执行 ffmpeg");
    },
    createTempDir: async () => tmpdir(),
    removeDir: async () => {},
  };
  const out = await runComposeNode({ ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" }, node: NODE, input: {}, deps });
  assert.equal(out.assetId, null);
  assert.equal(out.segments, 0);
});
