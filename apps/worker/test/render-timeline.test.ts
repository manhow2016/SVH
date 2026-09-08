/**
 * Timeline 渲染任务测试（V0.3 文档 Phase 8）。
 *
 * 约定：mock runFfmpeg（记录参数并写占位输出文件）+ 真实临时 SQLite 库；
 * 覆盖：成功链路（画面 concat/gap 补黑/音频混音/字幕烧录/资产落盘/时间轴回写）、
 * 素材缺失失败回写、构建函数单测（SRT 平移/音频对齐）与认领白名单。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productionTasks, type SVHDatabase } from "@svh/database";
import { eq } from "drizzle-orm";
import {
  DrizzleProductionRepository,
  TimelineService,
  type ProductionAsset,
} from "@svh/production";
import { claimTasks, type TimelineRenderTaskPayload } from "../src/queue";
import { runTask } from "../src/handlers";
import { buildGlobalSrt, parseSrtTime, toSrtTime } from "../src/render-timeline";
import { createTestEnv, seedTask, type TestEnv } from "./helpers/setup";

let env: TestEnv;
let db: SVHDatabase;
let timelineService: TimelineService;
let assetPage: ProductionAsset;
let assetAudio: ProductionAsset;
let assetSub: ProductionAsset;
let timelineId: string;

/** 造一个「本地化 ready」的素材（写占位文件到 media/<id>.mp4 并回写 workspacePath） */
async function seedLocalAsset(input: {
  type: "video" | "audio";
  name: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<ProductionAsset> {
  const asset = await env.production.createAsset({
    projectId: env.projectId,
    type: input.type,
    name: input.name,
    metadata: input.metadata,
  });
  const rel = `media/${asset.id}${input.type === "audio" ? ".mp3" : ".mp4"}`;
  const abs = join(env.workspaceRoot, env.workspaceId, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, input.content);
  await env.production.updateAssetFields(asset.id, { workspacePath: rel, mimeType: input.type === "audio" ? "audio/mpeg" : "video/mp4" });
  return asset;
}

/** 渲染任务 payload（Phase 7 快照格式，与 server TimelineRenderTaskPayload 同形） */
function makePayload(clips: TimelineRenderTaskPayload["clips"]): TimelineRenderTaskPayload {
  return {
    v: 1,
    timelineId,
    projectId: env.projectId,
    version: 1,
    fps: 24,
    width: 1920,
    height: 1080,
    clips,
  };
}

/** mock ffmpeg：记录参数；输出路径 = 参数末位（写占位文件满足 stat） */
function ffmpegRecorder() {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const runFfmpeg = async (args: string[], cwd?: string): Promise<void> => {
    calls.push({ args, cwd });
    const out = args[args.length - 1]!;
    if (!out.startsWith("-")) {
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, "out");
    }
  };
  return { runFfmpeg, calls };
}

test.before(async () => {
  env = await createTestEnv();
  db = env.db;
  const repo = new DrizzleProductionRepository(db);
  timelineService = new TimelineService(repo);

  assetPage = await seedLocalAsset({ type: "video", name: "画面素材", content: "v1" });
  assetAudio = await seedLocalAsset({ type: "audio", name: "配音素材", content: "a1" });
  assetSub = await env.production.createAsset({
    projectId: env.projectId,
    type: "subtitle",
    name: "字幕",
    metadata: { srt: "1\n00:00:01,000 --> 00:00:03,000\n你好呀\n" },
  });

  const tl = await timelineService.createTimeline({ projectId: env.projectId, name: "成片时间轴" });
  timelineId = tl.id;
  const track = await timelineService.createTrack({ timelineId: tl.id, type: "video", name: "视频轨" });
  const c1 = await timelineService.createClip({
    timelineId: tl.id,
    trackId: track.id,
    assetId: assetPage.id,
    startTime: 0,
    duration: 5,
  });
  assert.ok(c1.id);
});

test.after(() => {
  db.$client.close();
  env.cleanup();
});

/** 认领 + 执行 + 返回任务行 */
async function runRenderTask(payload: TimelineRenderTaskPayload, deps: Record<string, unknown>) {
  const taskId = seedTask(db, {
    projectId: env.projectId,
    userId: env.userId,
    kind: "timeline_render",
    rawPayload: JSON.stringify(payload),
  });
  const claimed = claimTasks(db, "wkr-r1", { limit: 5, staleMs: 60_000 });
  const task = claimed.find((t) => t.id === taskId);
  assert.ok(task, "timeline_render 应可被认领");
  await runTask(db, env.production, task, {
    pollIntervalMs: 0,
    workspaceRoot: env.workspaceRoot,
    log: () => undefined,
    ...deps,
  });
  return db.select().from(productionTasks).where(eq(productionTasks.id, taskId)).get();
}

test("成功链路：画面 concat（gap 补黑）+ 音频混音对齐 + 字幕烧录 + 资产落盘 + 时间轴回写", async () => {
  const { runFfmpeg, calls } = ffmpegRecorder();
  // 模拟 RenderTaskService（Phase 7）入队动作：ready → rendering
  await timelineService.updateTimeline(timelineId, { status: "editing" });
  await timelineService.updateTimeline(timelineId, { status: "ready" });
  const tl = await timelineService.updateTimeline(timelineId, { status: "rendering" });
  assert.equal(tl.status, "rendering");

  const payload = makePayload([
    { clipId: "c1", trackId: "trk1", trackType: "video", assetId: assetPage.id, startTime: 0, duration: 5 },
    { clipId: "c2", trackId: "trk1", trackType: "video", assetId: assetPage.id, startTime: 7, duration: 3, sourceStartTime: 2 },
    { clipId: "a1", trackId: "trk2", trackType: "audio", assetId: assetAudio.id, startTime: 7, duration: 3 },
    { clipId: "s1", trackId: "trk3", trackType: "subtitle", assetId: assetSub.id, startTime: 0, duration: 5 },
  ]);
  const row = await runRenderTask(payload, {
    timeline: timelineService,
    runFfmpeg,
    hasSubtitles: () => Promise.resolve(true),
  });
  assert.equal(row?.status, "completed");
  assert.equal(row?.progress, 100);
  assert.equal((await timelineService.getTimeline(timelineId)).status, "completed");

  // 画面段：trim c1（0-5）→ 黑段（gap 2s）→ trim c2（sourceStart=2, 7-10）
  const trimCalls = calls.filter((c) => c.args.join(" ").includes("-vf") && c.args[0] === "-y");
  assert.ok(trimCalls.length >= 3, `应有 2 个剪辑段 + 1 个黑段（实际 ${trimCalls.length}）`);
  const black = calls.find((c) => c.args.join("\n").includes("color=c=black:s=1920x1080:r=24"));
  assert.ok(black, "应包含 gap 补黑段");
  const trimWithSource = calls.find((c) => c.args.join(" ").includes("-ss 2"));
  assert.ok(trimWithSource, "第二段应使用 sourceStartTime=2 裁剪");
  // 音频：adelay 对齐 7s
  const amix = calls.find((c) => c.args.includes("-filter_complex"));
  assert.ok(amix, "应执行音频混音");
  assert.ok(amix!.args.join(" ").includes("adelay=7000"), "音频段应延迟到 7s");
  assert.ok(amix!.args.join(" ").includes("amix=inputs=1"));
  // 字幕：最终封装含 subtitles 滤镜（libass 可用）
  const finalMux = calls.find((c) => c.args.includes("subtitles=captions.srt"));
  assert.ok(finalMux, "应执行字幕烧录");
  assert.ok(finalMux!.args.includes("-c:v"), "字幕烧录应重编码");

  // 产物资产：video + media/ 路径 + localization.ready
  const assets = await env.production.listAssets(env.projectId, "video");
  const output = assets.find((a) => a.id !== assetPage.id);
  assert.ok(output, "应产出成片资产");
  assert.match(output!.workspacePath ?? "", /^media\/.+\.mp4$/);
  const locMeta = output!.metadata?.["localization"] as { state?: string } | undefined;
  assert.equal(locMeta?.state, "ready");
});

test("素材缺失：任务 failed + 时间轴 failed", async () => {
  // 模拟 RenderTaskService（Phase 7）入队动作：ready → rendering（否则回写 failed 非法）
  await timelineService.updateTimeline(timelineId, { status: "editing" });
  await timelineService.updateTimeline(timelineId, { status: "ready" });
  await timelineService.updateTimeline(timelineId, { status: "rendering" });
  const { runFfmpeg } = ffmpegRecorder();
  const row = await runRenderTask(
    makePayload([
      { clipId: "c9", trackId: "trk1", trackType: "video", assetId: "ast_missing", startTime: 0, duration: 5 },
    ]),
    { timeline: timelineService, runFfmpeg, hasSubtitles: () => Promise.resolve(true) },
  );
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /资产 不存在|素材不存在/);
  assert.equal((await timelineService.getTimeline(timelineId)).status, "failed");
  // failed 可回退再编辑（状态机完整性）
  await timelineService.updateTimeline(timelineId, { status: "editing" });
});

test("SRT 工具：toSrtTime / parseSrtTime / buildGlobalSrt（偏移 + 排序 + 重编号）", () => {
  assert.equal(toSrtTime(1.5), "00:00:01,500");
  assert.equal(toSrtTime(3661.25), "01:01:01,250");
  assert.equal(parseSrtTime("00:00:02,500"), 2.5);
  assert.equal(parseSrtTime("bad"), null);
  const srt = buildGlobalSrt([
    { offset: 10, srt: "1\n00:00:01,000 --> 00:00:02,000\n迟到\n" },
    { offset: 0, srt: "1\n00:00:00,500 --> 00:00:01,500\n早\n" },
  ]);
  const cues = srt.split(/\r?\n\r?\n/).filter(Boolean);
  assert.equal(cues.length, 2);
  assert.match(cues[0]!, /^1\n00:00:00,500 --> 00:00:01,500\n早\n?$/);
  assert.match(cues[1]!, /^2\n00:00:11,000 --> 00:00:12,000\n迟到\n?$/);
});

test("渲染载荷解析：损坏 payload（缺 timelineId）认领后判损坏落 failed", () => {
  const taskId = seedTask(db, {
    projectId: env.projectId,
    userId: env.userId,
    kind: "timeline_render",
    rawPayload: JSON.stringify({ v: 1, projectId: env.projectId, version: 1, fps: 24, width: 1920, height: 1080, clips: [] }),
  });
  const claimed = claimTasks(db, "wkr-bad", { limit: 5, staleMs: 60_000 });
  assert.ok(!claimed.some((t) => t.id === taskId), "损坏载荷不应被返回认领");
  const row = db.select().from(productionTasks).where(eq(productionTasks.id, taskId)).get();
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /payload 无法解析/);
});
