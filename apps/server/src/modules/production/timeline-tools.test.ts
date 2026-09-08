/**
 * Timeline Tools 集成测试（V0.3 文档 Phase 6）。
 *
 * 与 tools.test.ts 同一基建：真实 SQLite 临时库 + ProductionService /
 * TimelineService（均来自 @svh/production），直接调用工具工厂的 execute
 * （模拟 Agent Loop 工具执行路径）。
 *
 * 覆盖：时间轴 CRUD 全链路（create → track → clip → detail → update → delete）、
 * auto_create_timeline（素材裁决 + skipped）、输入校验与工作区隔离。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, users, workspaces, type SVHDatabase } from "@svh/database";
import {
  DrizzleProductionRepository,
  ProductionService,
  TimelineService,
  type ProductionAsset,
} from "@svh/production";
import {
  addTimelineClipTool,
  addTimelineTrackTool,
  autoCreateTimelineTool,
  createTimelineTool,
  deleteTimelineClipTool,
  getTimelineTool,
  updateTimelineClipTool,
} from "@svh/tools";
import type { ToolContext } from "@svh/tools";

let dir: string;
let db: SVHDatabase;
let repo: DrizzleProductionRepository;
let production: ProductionService;
let timeline: TimelineService;
let ctx: ToolContext;

let projectId: string;
let videoAsset: ProductionAsset;

/** 从工具返回值中取出 output */
function out(result: { output: unknown }): Record<string, unknown> {
  return result.output as Record<string, unknown>;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-timeline-tools-"));
  db = createDatabase(join(dir, "test.db"));
  repo = new DrizzleProductionRepository(db);
  production = new ProductionService(repo);
  timeline = new TimelineService(repo);

  // 用户 / 工作区（复刻 tools.test.ts 基建）
  const userId = "usr_tl_t1";
  db.insert(users)
    .values({
      id: userId,
      username: "tl-tools",
      email: "tl-tools@test.local",
      passwordHash: "x",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const wsId = "ws_tl_t1";
  db.insert(workspaces)
    .values({
      id: wsId,
      name: "ws",
      rootPath: join(dir, wsId),
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  ctx = { workspaceId: wsId, sessionId: "ses_tl_t1", workspaceRoot: join(dir, wsId) };

  // 项目 + 示例视频资产（工具层没有资产创建工具，直接经 ProductionService 构造）
  const project = await production.createProject({
    workspaceId: wsId,
    name: "时间轴工具项目",
    type: "short_drama",
    settings: {},
  });
  projectId = project.id;
  videoAsset = await repo.createAsset({
    projectId,
    workspaceId: wsId,
    userId,
    type: "video",
    name: "工具示例视频",
    url: "https://x/tool.mp4",
  });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("Timeline 工具全链路：create → track → clip → detail → update → delete", async () => {
  const timelineDeps = { production, timeline };

  // 1. create_timeline
  const created = out(
    await createTimelineTool(timelineDeps).execute(
      { projectId, name: "工具时间轴", fps: 30, width: 1280, height: 720 },
      ctx,
    ),
  );
  const timelineId = created.id as string;
  assert.equal(created.status, "draft");
  assert.equal(created.version, 0);
  assert.equal(created.fps, 30);

  // 2. add_timeline_track
  const track = out(
    await addTimelineTrackTool(timelineDeps).execute(
      { timelineId, type: "video", name: "视频轨" },
      ctx,
    ),
  );
  const trackId = track.id as string;
  assert.equal(track.order, 0);

  // 3. add_timeline_clip（video 轨必须绑资产）
  const clip = out(
    await addTimelineClipTool(timelineDeps).execute(
      { timelineId, trackId, assetId: videoAsset.id, startTime: 0, duration: 5 },
      ctx,
    ),
  );
  assert.equal(clip.assetId, videoAsset.id);
  assert.equal(clip.duration, 5);

  // 4. get_timeline（detail 聚合：派生列已重算）
  const detail = out(await getTimelineTool(timelineDeps).execute({ timelineId }, ctx)) as {
    timeline: { duration: number; version: number };
    clips: Array<{ id: string }>;
  };
  assert.equal(detail.timeline.duration, 5);
  assert.equal(detail.timeline.version, 1);
  assert.equal(detail.clips.length, 1);

  // 5. update_timeline_clip（改时长 → 重算）
  const updated = out(
    await updateTimelineClipTool(timelineDeps).execute(
      { clipId: clip.id as string, duration: 8 },
      ctx,
    ),
  );
  assert.equal(updated.duration, 8);
  const detail2 = out(await getTimelineTool(timelineDeps).execute({ timelineId }, ctx)) as {
    timeline: { duration: number };
  };
  assert.equal(detail2.timeline.duration, 8);

  // 6. delete_timeline_clip → duration 回落
  await deleteTimelineClipTool(timelineDeps).execute({ clipId: clip.id as string }, ctx);
  const detail3 = out(await getTimelineTool(timelineDeps).execute({ timelineId }, ctx)) as {
    timeline: { duration: number };
    clips: unknown[];
  };
  assert.equal(detail3.timeline.duration, 0);
  assert.equal(detail3.clips.length, 0);
});

test("auto_create_timeline：按镜头自动成轨（选中素材优先 + 生成记录回退 + skipped）", async () => {
  const autoDeps = { production, timeline };

  // 场景 → 分镜 → 两个镜头（5s / 3s）
  const scene = await production.createScene({
    projectId,
    name: "自动场景",
    description: "自动场景描述",
    order: 0,
  });
  const storyboard = await production.createStoryboard({
    projectId,
    sceneId: scene.id,
    description: "自动分镜",
    duration: 12,
    shotType: "medium",
    order: 0,
  });
  const shot1 = await production.createShot({
    projectId,
    storyboardId: storyboard.id,
    duration: 5,
    order: 0,
  });
  const shot2 = await production.createShot({
    projectId,
    storyboardId: storyboard.id,
    duration: 3,
    order: 1,
  });
  // 素材2（生成记录回退用）
  const genAsset = await repo.createAsset({
    projectId,
    workspaceId: ctx.workspaceId,
    userId: "usr_tl_t1",
    type: "video",
    name: "生成记录视频",
    url: "https://x/gen.mp4",
  });
  await repo.createGenerationRecord({
    projectId,
    shotId: shot2.id,
    kind: "video",
    version: 1,
    prompt: "p",
    status: "completed",
    reviewStatus: "generated",
    selected: false,
    outputAssetId: genAsset.id,
  });

  // shot2 有生成记录；shot1 无素材 → skipped
  const auto = out(
    await autoCreateTimelineTool(autoDeps).execute({ projectId, name: "成片" }, ctx),
  ) as {
    timeline: { duration: number; version: number; name: string };
    tracks: Array<{ type: string }>;
    clips: Array<{ shotId: string; assetId: string; startTime: number; duration: number }>;
    skipped: Array<{ shotId: string }>;
  };
  assert.equal(auto.timeline.name, "成片");
  assert.equal(auto.timeline.duration, 3);
  assert.equal(auto.timeline.version, 1);
  assert.equal(auto.tracks.length, 1);
  assert.equal(auto.tracks[0]!.type, "video");
  assert.equal(auto.clips.length, 1);
  assert.equal(auto.clips[0]!.shotId, shot2.id);
  assert.equal(auto.clips[0]!.assetId, genAsset.id);
  assert.equal(auto.clips[0]!.startTime, 0);
  assert.equal(auto.clips[0]!.duration, 3);
  assert.deepEqual(auto.skipped.map((s) => s.shotId), [shot1.id]);
});

test("输入校验：缺必填字段抛 ToolError；跨工作区报不存在", async () => {
  const timelineDeps = { production, timeline };
  await assert.rejects(
    createTimelineTool(timelineDeps).execute({ projectId }, ctx),
    (err: unknown) => err instanceof Error && err.name === "ToolError",
  );
  await assert.rejects(
    addTimelineClipTool(timelineDeps).execute(
      { timelineId: "tml_x", trackId: "trk_x", duration: 1 },
      ctx,
    ),
    (err: unknown) => err instanceof Error && err.name === "ToolError",
  );

  // 工作区隔离：不存在的时间轴 → 「时间轴 不存在」
  await assert.rejects(
    getTimelineTool(timelineDeps).execute({ timelineId: "tml_none" }, ctx),
    /时间轴 不存在/,
  );

  // 跨工作区（同一项目时间轴，不同 workspace）→ 统一按不存在处理
  const otherCtx: ToolContext = { ...ctx, workspaceId: "ws_other" };
  const tl = await timeline.createTimeline({ projectId, name: "隔离时间轴" });
  await assert.rejects(
    getTimelineTool(timelineDeps).execute({ timelineId: tl.id }, otherCtx),
    /不存在/,
  );
});
