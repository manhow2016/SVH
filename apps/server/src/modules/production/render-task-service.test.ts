/**
 * RenderTaskService 测试（V0.3 文档 Phase 7：Render Task）。
 *
 * 真实临时 SQLite + DrizzleProductionRepository：
 * 验证 ready→rendering 状态机、queued 任务落库与 payload 快照、
 * 非 ready 拒绝（CONFLICT）、无视频轨剪辑拒绝（VALIDATION）、
 * 整轴越界防御（固定时长校验）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, productionTasks, type SVHDatabase } from "@svh/database";
import { eq } from "drizzle-orm";
import {
  DrizzleProductionRepository,
  ProductionError,
  TimelineService,
  type ProductionAsset,
} from "@svh/production";
import { RenderTaskService, type TimelineRenderTaskPayload } from "./render-task-service";

let dir: string;
let db: SVHDatabase;
let repo: DrizzleProductionRepository;
let timelineService: TimelineService;
let render: RenderTaskService;

let projectId: string;
let videoAsset: ProductionAsset;
let audioAsset: ProductionAsset;

async function assertProductionError(
  promise: Promise<unknown>,
  pattern?: RegExp,
  code?: string,
): Promise<ProductionError> {
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

async function setupReadyTimeline(): Promise<{ timelineId: string; trackId: string }> {
  const tl = await timelineService.createTimeline({ projectId, name: "渲染时间轴" });
  await timelineService.updateTimeline(tl.id, { status: "ready" });
  const track = await timelineService.createTrack({ timelineId: tl.id, type: "video", name: "视频轨" });
  await timelineService.createClip({
    timelineId: tl.id,
    trackId: track.id,
    assetId: videoAsset.id,
    startTime: 0,
    duration: 5,
  });
  return { timelineId: tl.id, trackId: track.id };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-render-task-"));
  db = createDatabase(join(dir, "test.db"));
  repo = new DrizzleProductionRepository(db);
  timelineService = new TimelineService(repo);
  render = new RenderTaskService({ db, repo });

  const now = Date.now();
  db.$client.exec(
    `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
       VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
     INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
       VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});`,
  );
  const project = await repo.createProject({
    workspaceId: "ws1",
    userId: "u1",
    name: "渲染项目",
    type: "short_drama",
    status: "planning",
    settings: {},
  });
  projectId = project.id;
  videoAsset = await repo.createAsset({
    projectId,
    workspaceId: "ws1",
    userId: "u1",
    type: "video",
    name: "渲染视频",
    url: "https://x/render.mp4",
  });
  audioAsset = await repo.createAsset({
    projectId,
    workspaceId: "ws1",
    userId: "u1",
    type: "audio",
    name: "渲染音频",
    url: "https://x/render.mp3",
  });
});

after(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("renderTimeline：ready → rendering + queued 任务（payload 快照）", async () => {
  const { timelineId } = await setupReadyTimeline();
  const result = await render.renderTimeline(timelineId, "u1");
  assert.equal(result.task.kind, "timeline_render");
  assert.equal(result.task.status, "queued");
  assert.equal(result.task.projectId, projectId);
  assert.equal(result.timeline.status, "rendering");

  // 任务行落库：payload 快照包含渲染目标与剪辑静态信息
  const row = db.select().from(productionTasks).where(eq(productionTasks.id, result.task.id)).get();
  assert.ok(row, "任务行应存在");
  const payload = JSON.parse(row!.payload ?? "{}") as TimelineRenderTaskPayload;
  assert.equal(payload.v, 1);
  assert.equal(payload.timelineId, timelineId);
  assert.equal(payload.projectId, projectId);
  assert.equal(payload.version, 1, "快照 version = 入队时刻版本");
  assert.equal(payload.fps, 24);
  assert.equal(payload.clips.length, 1);
  assert.ok(payload.clips[0]!.clipId.length > 0, "快照包含剪辑 id");
  assert.equal(payload.clips[0]!.trackType, "video");
  assert.equal(payload.clips[0]!.assetId, videoAsset.id);
  assert.equal(payload.clips[0]!.startTime, 0);
  assert.equal(payload.clips[0]!.duration, 5);
});

test("renderTimeline：非 ready 状态拒绝（CONFLICT）；重复提交拒绝", async () => {
  // draft（未置 ready）
  const draft = await timelineService.createTimeline({ projectId, name: "未就绪" });
  await assertProductionError(
    render.renderTimeline(draft.id, "u1"),
    /不允许从 draft/,
    "CONFLICT",
  );
  // rendering 中重复提交
  const { timelineId } = await setupReadyTimeline();
  await render.renderTimeline(timelineId, "u1");
  await assertProductionError(
    render.renderTimeline(timelineId, "u1"),
    /正在渲染中/,
    "CONFLICT",
  );
});

test("renderTimeline：无视频轨剪辑拒绝（VALIDATION）", async () => {
  // 空时间轴（ready）
  const empty = await timelineService.createTimeline({ projectId, name: "空轴" });
  await timelineService.updateTimeline(empty.id, { status: "ready" });
  await assertProductionError(
    render.renderTimeline(empty.id, "u1"),
    /没有视频轨剪辑/,
    "VALIDATION",
  );
  // 仅音频轨剪辑（无视频画面来源）
  const audioOnly = await timelineService.createTimeline({ projectId, name: "音频轴" });
  await timelineService.updateTimeline(audioOnly.id, { status: "ready" });
  const audioTrack = await timelineService.createTrack({ timelineId: audioOnly.id, type: "audio", name: "音频轨" });
  await timelineService.createClip({
    timelineId: audioOnly.id,
    trackId: audioTrack.id,
    assetId: audioAsset.id,
    startTime: 0,
    duration: 5,
  });
  await assertProductionError(
    render.renderTimeline(audioOnly.id, "u1"),
    /没有视频轨剪辑/,
    "VALIDATION",
  );
});

test("renderTimeline：整轴越界防御（直接改派生列后渲染拒绝）", async () => {
  const { timelineId } = await setupReadyTimeline();
  // 模拟数据不一致：把 timeline.duration 手工缩到 < 剪辑末点（service 层忽略人工改派生列，
  // 此处经 repo 直写制造脏数据，验证渲染前固定时长校验兜底）
  await repo.updateTimeline(timelineId, { duration: 1 });
  await assertProductionError(
    render.renderTimeline(timelineId, "u1"),
    /超出时间轴范围/,
    "VALIDATION",
  );
});

test("renderTimeline：时间轴不存在抛 NOT_FOUND", async () => {
  await assertProductionError(render.renderTimeline("tml_missing", "u1"), /时间轴 不存在/, "NOT_FOUND");
});
