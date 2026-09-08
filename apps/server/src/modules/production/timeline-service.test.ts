/**
 * TimelineService 测试（V0.3 Phase 2 / Phase 3）。
 *
 * 用真实临时 SQLite + DrizzleProductionRepository（领域仓储适配层），
 * 验证：创建默认值、Track 顺序、Clip 规则（3/4/6/7/8）、派生列维护
 * （duration 重算 + version 递增）、重排、状态机与级联删除。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type SVHDatabase } from "@svh/database";
import {
  DrizzleProductionRepository,
  ProductionError,
  type ProductionAsset,
} from "@svh/production";
import { TimelineService } from "./timeline-service";

let dir: string;
let db: SVHDatabase;
let repo: DrizzleProductionRepository;
let service: TimelineService;

let projectA: string;
let projectB: string;

let videoAsset: ProductionAsset;
let audioAsset: ProductionAsset;
let bVideoAsset: ProductionAsset;
let shotA: string;

/** 断言抛 ProductionError（可选校验 message 匹配） */
async function assertProductionError(promise: Promise<unknown>, pattern?: RegExp, code?: string): Promise<ProductionError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ProductionError, `应抛 ProductionError（实际 ${String(err)}）`);
    if (pattern) assert.match((err as Error).message, pattern);
    if (code) assert.equal((err as ProductionError).code, code);
    return err as ProductionError;
  }
  assert.fail("应抛 ProductionError 但未抛");
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-timeline-svc-"));
  db = createDatabase(join(dir, "test.db"));
  repo = new DrizzleProductionRepository(db);
  service = new TimelineService(repo);

  const now = Date.now();
  db.$client.exec(
    `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
       VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
     INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
       VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});`,
  );
  const pA = await repo.createProject({
    workspaceId: "ws1",
    userId: "u1",
    name: "项目A",
    type: "short_drama",
    status: "planning",
    settings: {},
  });
  const pB = await repo.createProject({
    workspaceId: "ws1",
    userId: "u1",
    name: "项目B",
    type: "short_drama",
    status: "planning",
    settings: {},
  });
  projectA = pA.id;
  projectB = pB.id;

  videoAsset = await repo.createAsset({
    projectId: projectA,
    workspaceId: "ws1",
    userId: "u1",
    type: "video",
    name: "镜头1视频",
    url: "https://x/1.mp4",
  });
  audioAsset = await repo.createAsset({
    projectId: projectA,
    workspaceId: "ws1",
    userId: "u1",
    type: "audio",
    name: "配音1",
    url: "https://x/1.mp3",
  });
  bVideoAsset = await repo.createAsset({
    projectId: projectB,
    workspaceId: "ws1",
    userId: "u1",
    type: "video",
    name: "B项目视频",
    url: "https://x/b.mp4",
  });

  // 镜头（scene/storyboard 最小链条，仅满足外键）
  db.$client.exec(
    `INSERT INTO production_scenes (id, project_id, script_id, sort_order, name, description, location, time, characters, visual_style, created_at, updated_at)
       VALUES ('scn1', '${projectA}', NULL, 0, '场景1', 'x', NULL, NULL, '[]', NULL, ${now}, ${now});
     INSERT INTO production_storyboards (id, project_id, scene_id, sort_order, description, duration, shot_type, camera_movement, image_prompt, video_prompt, status, created_at, updated_at)
       VALUES ('sbd1', '${projectA}', 'scn1', 0, 'x', 5, 'medium', NULL, NULL, NULL, 'draft', ${now}, ${now});
     INSERT INTO production_shots (id, project_id, storyboard_id, sort_order, duration, framing, camera_movement, action, dialogue, image_asset_id, video_asset_id, audio_asset_id, status, visual_style, created_at, updated_at)
       VALUES ('sht1', '${projectA}', 'sbd1', 0, 5, NULL, NULL, NULL, NULL, NULL, '${videoAsset.id}', '${audioAsset.id}', 'ready', NULL, ${now}, ${now});`,
  );
  shotA = "sht1";
});

after(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

// ================= Timeline 创建 =================

test("createTimeline：默认值（draft/version 0/24fps/1920x1080）", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: " 主时间轴 " });
  assert.equal(tl.name, "主时间轴");
  assert.equal(tl.duration, 0);
  assert.equal(tl.fps, 24);
  assert.equal(tl.width, 1920);
  assert.equal(tl.height, 1080);
  assert.equal(tl.status, "draft");
  assert.equal(tl.version, 0);
});

test("createTimeline：项目不存在抛 NOT_FOUND", async () => {
  await assertProductionError(
    service.createTimeline({ projectId: "missing", name: "x" }),
    /项目 不存在/,
    "NOT_FOUND",
  );
});

// ================= Track =================

test("createTrack：默认 order 追加（0, 1）", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "轨道测试" });
  const t1 = await service.createTrack({ timelineId: tl.id, type: "video", name: "视频轨" });
  const t2 = await service.createTrack({ timelineId: tl.id, type: "audio", name: "音频轨" });
  assert.equal(t1.order, 0);
  assert.equal(t2.order, 1);
  assert.equal(t1.type, "video");
});

test("createTrack：非法类型/负 order 抛 VALIDATION", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "校验轨道" });
  await assertProductionError(
    // @ts-expect-error —— 模拟运行时非法值
    service.createTrack({ timelineId: tl.id, type: "effects", name: "x" }),
    /轨道类型/,
    "VALIDATION",
  );
  await assertProductionError(
    service.createTrack({ timelineId: tl.id, type: "video", name: "x", order: -1 }),
    />= 0/,
    "VALIDATION",
  );
});

// ================= Clip 规则（3/4/6/7/8） =================

test("createClip：video 轨道必须绑定 video 资产（规则 3）", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "绑定测试" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  // 未绑定 → 拒绝
  await assertProductionError(
    service.createClip({ timelineId: tl.id, trackId: track.id, startTime: 0, duration: 2 }),
    /必须关联资产/,
    "VALIDATION",
  );
  // 绑定 audio 资产 → 拒绝（类型不匹配）
  await assertProductionError(
    service.createClip({
      timelineId: tl.id,
      trackId: track.id,
      assetId: audioAsset.id,
      startTime: 0,
      duration: 2,
    }),
    /要求 video 资产/,
    "VALIDATION",
  );
  // 绑定 video 资产 → 成功（audio 轨道同理）
  const clip = await service.createClip({
    timelineId: tl.id,
    trackId: track.id,
    assetId: videoAsset.id,
    shotId: shotA,
    startTime: 0,
    duration: 2,
  });
  assert.equal(clip.assetId, videoAsset.id);
  assert.equal(clip.shotId, shotA);
});

test("createClip：资产不存在抛 NOT_FOUND（规则 7 前置）", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "引用测试" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  await assertProductionError(
    service.createClip({ timelineId: tl.id, trackId: track.id, assetId: "missing-asset", startTime: 0, duration: 2 }),
    /资产 不存在/,
    "NOT_FOUND",
  );
});

test("createClip：资产/镜头跨项目引用被拒绝（规则 7/8）", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "隔离测试" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  await assertProductionError(
    service.createClip({ timelineId: tl.id, trackId: track.id, assetId: bVideoAsset.id, startTime: 0, duration: 2 }),
    /不属于当前项目/,
    "VALIDATION",
  );
  await assertProductionError(
    service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, shotId: "sht-b", startTime: 0, duration: 2 }),
    /镜头 不存在/,
    "NOT_FOUND",
  );
});

test("createClip：起点越界拒绝（规则 6）、贴边延伸允许（duration 重算）", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "时长测试" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  const c1 = await service.createClip({
    timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 0, duration: 5,
  });
  let updated = await service.getTimeline(tl.id);
  assert.equal(updated.duration, 5, "时长 = 最大 clip 终点");
  assert.equal(updated.version, 1, "内容变更 version +1");

  // start 超过当前时长 → 拒绝
  await assertProductionError(
    service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 5.01, duration: 1 }),
    /起点超出时间轴范围/,
    "VALIDATION",
  );
  // start 恰好 == 当前时长（贴边追加）→ 允许且延伸时间轴
  const c2 = await service.createClip({
    timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 5, duration: 3,
  });
  assert.equal(c2.startTime, 5);
  updated = await service.getTimeline(tl.id);
  assert.equal(updated.duration, 8);
  assert.equal(updated.version, 2);
  void c1;
});

test("updateClip：改时长后重算；video 轨道解绑 asset 被拒", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "更新测试" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  const clip = await service.createClip({
    timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 0, duration: 4,
  });
  const updated = await service.updateClip(clip.id, { duration: 10, sourceStartTime: 1 });
  assert.equal(updated.duration, 10);
  assert.equal(updated.sourceStartTime, 1);
  const tl2 = await service.getTimeline(tl.id);
  assert.equal(tl2.duration, 10);

  // 显式解绑 asset（null）→ video 轨道失去绑定 → 拒绝
  await assertProductionError(
    service.updateClip(clip.id, { assetId: null }),
    /必须关联资产/,
    "VALIDATION",
  );
});

test("deleteClip：时长重算回落 + version 递增", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "删除测试" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  const c1 = await service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 0, duration: 5 });
  const c2 = await service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 5, duration: 3 });
  assert.equal((await service.getTimeline(tl.id)).duration, 8);
  assert.equal((await service.getTimeline(tl.id)).version, 2);
  // 删除覆盖到最晚位置（end=8）的剪辑 → 回落至剩余 max end（5）
  await service.deleteClip(c2.id);
  const tl2 = await service.getTimeline(tl.id);
  assert.equal(tl2.duration, 5);
  assert.equal(tl2.version, 3, "两次创建(+2) + 一次删除(+1)");
  void c1;
});

test("deleteTrack：同轨剪辑级联删除并重算", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "轨道删除" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  await service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 0, duration: 6 });
  await service.deleteTrack(track.id);
  const tl2 = await service.getTimeline(tl.id);
  assert.equal(tl2.duration, 0);
  assert.equal((await service.getTimelineDetail(tl.id)).clips.length, 0);
});

test("deleteTimeline：级联清空 + 再取抛 NOT_FOUND", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "级联删除" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  await service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 0, duration: 2 });
  await service.deleteTimeline(tl.id);
  await assertProductionError(service.getTimeline(tl.id), /时间轴 不存在/, "NOT_FOUND");
  await assertProductionError(service.getTrack(track.id), /轨道 不存在/, "NOT_FOUND");
});

// ================= 重排 =================

test("reorderTracks：集合不一致拒绝；正常重排写回 order", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "重排轨" });
  const t1 = await service.createTrack({ timelineId: tl.id, type: "video", name: "v1" });
  const t2 = await service.createTrack({ timelineId: tl.id, type: "audio", name: "a1" });
  await assertProductionError(
    service.reorderTracks(tl.id, [t1.id]),
    /数量与现有轨道集合不一致/,
    "VALIDATION",
  );
  const reordered = await service.reorderTracks(tl.id, [t2.id, t1.id]);
  assert.equal(reordered[0]!.id, t2.id);
  assert.equal(reordered[0]!.order, 0);
  assert.equal(reordered[1]!.id, t1.id);
  assert.equal(reordered[1]!.order, 1);
});

test("reorderClips：同轨剪辑内排序", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "重排剪辑" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  const c1 = await service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 0, duration: 2 });
  const c2 = await service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 2, duration: 2, order: 1 });
  const reordered = await service.reorderClips(track.id, [c2.id, c1.id]);
  assert.equal(reordered[0]!.id, c2.id);
  assert.equal(reordered[0]!.order, 0);
});

// ================= 状态机 / 详情 =================

test("updateTimeline：状态机合法跳转与非法跳转", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "状态机" });
  let updated = await service.updateTimeline(tl.id, { status: "ready" });
  assert.equal(updated.status, "ready");
  updated = await service.updateTimeline(tl.id, { status: "rendering" });
  assert.equal(updated.status, "rendering");
  await assertProductionError(
    service.updateTimeline(tl.id, { status: "editing" }),
    /不允许从 rendering/,
    "CONFLICT",
  );
  updated = await service.updateTimeline(tl.id, { status: "completed" });
  assert.equal(updated.status, "completed");
  // completed → ready（重渲染）+ failed 不可达 ready→failed
  await assertProductionError(service.updateTimeline(tl.id, { status: "failed" }), /不允许从 completed/, "CONFLICT");
});

test("updateTimeline：duration/version 派生列忽略人工修改", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "派生忽略" });
  // 仅传派生列 → 视为无合法字段
  await assertProductionError(
    service.updateTimeline(tl.id, { duration: 99, version: 42 } as never),
    /至少需要一个可更新字段/,
    "VALIDATION",
  );
});

test("getTimelineDetail：返回 timeline + tracks + clips", async () => {
  const tl = await service.createTimeline({ projectId: projectA, name: "详情" });
  const track = await service.createTrack({ timelineId: tl.id, type: "video", name: "v" });
  await service.createClip({ timelineId: tl.id, trackId: track.id, assetId: videoAsset.id, startTime: 0, duration: 2 });
  const detail = await service.getTimelineDetail(tl.id);
  assert.equal(detail.timeline.id, tl.id);
  assert.equal(detail.tracks.length, 1);
  assert.equal(detail.clips.length, 1);
  assert.equal(detail.clips[0]!.trackId, track.id);
});
