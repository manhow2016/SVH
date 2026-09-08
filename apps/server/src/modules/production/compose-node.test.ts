/**
 * 成片组装节点执行器核心测试（video.compose v2）：命令拼装 + 音轨对齐 + 字幕烧录分支。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
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

/** mock：runFfmpeg 把最后一个参数当输出文件落地（视觉/音轨/mux/烧录链的中间产物） */
function fakeFfmpeg(calls: Array<{ args: string[] }>, tempOut: string) {
  return async (args: string[]): Promise<void> => {
    calls.push({ args });
    const out = args[args.length - 1]!;
    if (typeof out === "string" && /\.(mp4|m4a)$/.test(out) && !out.startsWith("http")) {
      writeFileSync(out, Buffer.from("dummy"));
    }
    void tempOut;
  };
}

test("compose：画面 concat + 音轨对齐 mux + 字幕烧录（subtitles 滤镜可用）", async () => {
  const calls: Array<{ args: string[] }> = [];
  let marked: { id: string; wp: string; bytes: number } | undefined;
  const tempRoot = join(tmpdir(), `svh-compose-test-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const deps: ComposeNodeDeps = {
    listStoryboards: async () => [{ id: "sto_1", order: 0 }],
    listShotsByStoryboard: async () => [
      { order: 0, duration: 3, videoAssetId: "ast_v1", audioAssetId: "ast_a1", dialogue: "开场" },
      { order: 1, duration: 2, imageAssetId: "ast_img1", dialogue: "再见" },
    ],
    localAssetPath: async (assetId) =>
      assetId === "ast_v1" ? "/media/seg1.mp4" : assetId === "ast_img1" ? "/media/img1.png" : "/media/a1.mp3",
    createComposedAsset: async () => ({ id: "ast_out", workspaceId: "ws" }),
    prepareOutput: async () => ({ abs: join(tempRoot, "out.mp4"), workspacePath: "media/ast_out.mp4" }),
    markOutputReady: async (id, wp, bytes) => {
      marked = { id, wp, bytes };
    },
    runFfmpeg: fakeFfmpeg(calls, tempRoot),
    hasSubtitles: async () => true,
    createTempDir: async () => tempRoot,
    removeDir: async () => {},
  };
  const out = await runComposeNode({ ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" }, node: NODE, input: {}, deps });
  // 5 次调用：图片段 loop → 画面 concat → 音频 concat → mux → 烧录
  assert.equal(calls.length, 5);
  assert.ok(calls[0]!.args.includes("-loop") && calls[0]!.args.includes("/media/img1.png"), "图片段应 loop 转换");
  assert.ok(calls[1]!.args.includes("concat") && calls[1]!.args.some((a) => a.includes("visual_list.txt")), "画面 concat");
  assert.ok(calls[2]!.args.some((a) => a.includes("audio_list.txt")), "音频 concat");
  assert.ok(calls[3]!.args.includes("-map") && calls[3]!.args.includes("0:v") && calls[3]!.args.includes("1:a"), "mux 映射");
  assert.ok(calls[4]!.args.includes("subtitles=captions.srt"), "字幕烧录");
  assert.equal(out.assetId, "ast_out");
  assert.equal(out.segments, 2);
  assert.equal(out.audioSegments, 1);
  assert.equal(out.burned, true);
  assert.deepEqual(marked, { id: "ast_out", wp: "media/ast_out.mp4", bytes: "dummy".length });
});

test("compose：无字幕滤镜 → 跳过烧录（reason 注明），其余照常", async () => {
  const calls: Array<{ args: string[] }> = [];
  const tempRoot = join(tmpdir(), `svh-compose-test2-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const deps: ComposeNodeDeps = {
    listStoryboards: async () => [{ id: "sto_1", order: 0 }],
    listShotsByStoryboard: async () => [
      { order: 0, duration: 2, imageAssetId: "ast_img1", dialogue: "没有滤镜也烧" },
    ],
    localAssetPath: async () => "/media/img1.png",
    createComposedAsset: async () => ({ id: "ast_out", workspaceId: "ws" }),
    prepareOutput: async () => ({ abs: join(tempRoot, "out.mp4"), workspacePath: "media/ast_out.mp4" }),
    markOutputReady: async () => {},
    runFfmpeg: fakeFfmpeg(calls, tempRoot),
    hasSubtitles: async () => false,
    createTempDir: async () => tempRoot,
    removeDir: async () => {},
  };
  const out = await runComposeNode({ ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" }, node: NODE, input: {}, deps });
  assert.equal(out.burned, false);
  assert.match(out.reason ?? "", /滤镜不可用/);
  assert.equal(calls.length, 2, "仅图片 loop + 画面 concat（无 audio/mux/burn）");
  assert.ok(!calls.some((c) => c.args.includes("subtitles=captions.srt")));
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
    hasSubtitles: async () => true,
    createTempDir: async () => tmpdir(),
    removeDir: async () => {},
  };
  const out = await runComposeNode({ ctx: { projectId: "p1", workflowId: "wfl_1", userId: "u1" }, node: NODE, input: {}, deps });
  assert.equal(out.assetId, null);
  assert.equal(out.segments, 0);
});
