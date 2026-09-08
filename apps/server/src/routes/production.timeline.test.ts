/**
 * Timeline REST API 路由测试（V0.3 Phase 4）。
 *
 * 复用 production.crud.test.ts 基建：buildApp + app.inject + 真实临时库 + 双用户。
 * 覆盖：Timeline / Track / Clip 全链路 CRUD、detail 聚合、属性校验、
 * 越权访问一律 404（统一隐藏存在性）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;

let tokenA: string;
let tokenB: string;
let workspaceId: string;
let projectId: string;
let videoAssetId: string;
let audioAssetId: string;

async function call(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  opts: { token?: string; body?: InjectOptions["payload"] } = {},
) {
  return app.inject({
    method,
    url,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : undefined,
    payload: opts.body,
  });
}

async function register(username: string): Promise<string> {
  const res = await call("POST", "/api/auth/register", {
    body: { username, email: `${username}@tl.local`, password: "Crud12345" },
  });
  assert.equal(res.statusCode, 201, `注册应 201（${res.statusCode}：${res.body}）`);
  const login = await call("POST", "/api/auth/login", {
    body: { identifier: username, password: "Crud12345" },
  });
  assert.equal(login.statusCode, 200, `登录应 200（${login.statusCode}）`);
  return (login.json() as { token: string }).token;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-timeline-route-"));
  const config: AppConfig = {
    port: 0,
    databaseUrl: join(dir, "test.db"),
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "timeline-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });

  tokenA = await register("timeline_a");
  tokenB = await register("timeline_b");

  const ws = await call("POST", "/api/workspaces", { token: tokenA, body: { name: "tl-ws" } });
  workspaceId = (ws.json() as { id: string }).id;
  const pj = await call("POST", "/api/productions", {
    token: tokenA,
    body: { workspaceId, name: "时间轴项目" },
  });
  projectId = (pj.json() as { id: string }).id;

  // 先备 video / audio 资产（手动录入）
  const vAsset = await call("POST", `/api/projects/${projectId}/assets`, {
    token: tokenA,
    body: { type: "video", name: "镜头1" },
  });
  const aAsset = await call("POST", `/api/projects/${projectId}/assets`, {
    token: tokenA,
    body: { type: "audio", name: "配音1" },
  });
  videoAssetId = (vAsset.json() as { id: string }).id;
  audioAssetId = (aAsset.json() as { id: string }).id;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function assertNotFound(res: { statusCode: number }): void {
  assert.equal(res.statusCode, 404, `应 404（实际 ${res.statusCode}）`);
}

test("Timeline 全链路：创建 → 列表 → 详情 → 更新 → 删除", async () => {
  // 创建
  const created = await call("POST", `/api/projects/${projectId}/timelines`, {
    token: tokenA,
    body: { name: "主时间轴", description: "成片主时间轴" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const timeline = created.json() as {
    id: string; name: string; fps: number; width: number; height: number; status: string; version: number;
  };
  assert.equal(timeline.name, "主时间轴");
  assert.equal(timeline.fps, 24);
  assert.equal(timeline.width, 1920);
  assert.equal(timeline.status, "draft");
  assert.equal(timeline.version, 0);

  // 列表
  const list = await call("GET", `/api/projects/${projectId}/timelines`, { token: tokenA });
  assert.equal(list.statusCode, 200);
  assert.equal((list.json() as unknown[]).length, 1);

  // 详情（空）
  const detail = await call("GET", `/api/timelines/${timeline.id}`, { token: tokenA });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual((detail.json() as { tracks: unknown[]; clips: unknown[] }).clips, []);

  // 更新名称 + 状态 ready
  const patched = await call("PATCH", `/api/timelines/${timeline.id}`, {
    token: tokenA,
    body: { name: "主时间轴v2", status: "ready" },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((patched.json() as { name: string; status: string }).name, "主时间轴v2");
  assert.equal((patched.json() as { status: string }).status, "ready");

  // 删除
  const deleted = await call("DELETE", `/api/timelines/${timeline.id}`, { token: tokenA });
  assert.equal(deleted.statusCode, 200);
  assertNotFound(await call("GET", `/api/timelines/${timeline.id}`, { token: tokenA }));
});

test("Track + Clip 链路：建轨 → 绑定资产建剪辑 → 详情 → 重排数据 → 级联删除", async () => {
  const created = await call("POST", `/api/projects/${projectId}/timelines`, {
    token: tokenA,
    body: { name: "剪辑链路" },
  });
  const timelineId = (created.json() as { id: string }).id;

  // 建两条轨
  const vTrack = await call("POST", `/api/timelines/${timelineId}/tracks`, {
    token: tokenA,
    body: { type: "video", name: "视频轨" },
  });
  const aTrack = await call("POST", `/api/timelines/${timelineId}/tracks`, {
    token: tokenA,
    body: { type: "audio", name: "音频轨" },
  });
  assert.equal(vTrack.statusCode, 200, vTrack.body);
  const vTrackId = (vTrack.json() as { id: string }).id;
  const aTrackId = (aTrack.json() as { id: string }).id;

  // video 轨道不绑资产 → 400
  const badClip = await call("POST", `/api/timeline-tracks/${vTrackId}/clips`, {
    token: tokenA,
    body: { startTime: 0, duration: 5 },
  });
  assert.equal(badClip.statusCode, 400, `缺资产应 400（实际 ${badClip.statusCode}：${badClip.body}）`);

  // 合法 video 剪辑 + audio 剪辑
  const clip1 = await call("POST", `/api/timeline-tracks/${vTrackId}/clips`, {
    token: tokenA,
    body: { assetId: videoAssetId, startTime: 0, duration: 5 },
  });
  assert.equal(clip1.statusCode, 200, clip1.body);
  const clip1Id = (clip1.json() as { id: string; startTime: number; duration: number }).id;
  const clip2 = await call("POST", `/api/timeline-tracks/${vTrackId}/clips`, {
    token: tokenA,
    body: { assetId: videoAssetId, startTime: 5, duration: 3 },
  });
  assert.equal(clip2.statusCode, 200, clip2.body);
  const clip2Id = (clip2.json() as { id: string }).id;
  await call("POST", `/api/timeline-tracks/${aTrackId}/clips`, {
    token: tokenA,
    body: { assetId: audioAssetId, startTime: 0, duration: 8 },
  });

  // 详情聚合：duration 重算 + version 递增 + 剪辑数
  const detail = await call("GET", `/api/timelines/${timelineId}`, { token: tokenA });
  const detailBody = detail.json() as {
    timeline: { duration: number; version: number };
    tracks: Array<{ id: string; type: string }>;
    clips: Array<{ id: string }>;
  };
  assert.equal(detailBody.timeline.duration, 8);
  assert.equal(detailBody.timeline.version, 3);
  assert.equal(detailBody.tracks.length, 2);
  assert.equal(detailBody.clips.length, 3);

  // PATCH 剪辑（移动起点）
  const moved = await call("PATCH", `/api/timeline-clips/${clip2Id}`, {
    token: tokenA,
    body: { startTime: 6, duration: 4 },
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((moved.json() as { startTime: number; duration: number }).duration, 4);

  // 删除 track → 级联删其剪辑，duration 回落
  await call("DELETE", `/api/timeline-tracks/${vTrackId}`, { token: tokenA });
  const detail2 = await call("GET", `/api/timelines/${timelineId}`, { token: tokenA });
  const d2 = detail2.json() as {
    timeline: { duration: number };
    clips: Array<{ id: string }>;
  };
  assert.equal(d2.timeline.duration, 8, "audio 轨 8s 保留");
  assert.equal(d2.clips.length, 1);

  // 删除单个剪辑
  const audioClipId = d2.clips[0]!.id;
  await call("DELETE", `/api/timeline-clips/${audioClipId}`, { token: tokenA });
  assert.equal((await call("GET", `/api/timelines/${timelineId}`, { token: tokenA })).json()["timeline"].duration, 0);

  void clip1Id;
  // 清场（级联验证）
});

test("越权访问一律 404（隐藏存在性）", async () => {
  const created = await call("POST", `/api/projects/${projectId}/timelines`, {
    token: tokenA,
    body: { name: "越权时间轴" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const timelineId = (created.json() as { id: string }).id;
  const track = await call("POST", `/api/timelines/${timelineId}/tracks`, {
    token: tokenA,
    body: { type: "video", name: "v" },
  });
  const trackId = (track.json() as { id: string }).id;

  // B 用户访问 A 的任何资源 → 404
  assertNotFound(await call("GET", `/api/timelines/${timelineId}`, { token: tokenB }));
  assertNotFound(await call("PATCH", `/api/timelines/${timelineId}`, { token: tokenB, body: { name: "x" } }));
  assertNotFound(await call("DELETE", `/api/timelines/${timelineId}`, { token: tokenB }));
  assertNotFound(await call("POST", `/api/timelines/${timelineId}/tracks`, { token: tokenB, body: { type: "video", name: "x" } }));
  assertNotFound(await call("PATCH", `/api/timeline-tracks/${trackId}`, { token: tokenB, body: { name: "x" } }));
  // B 往 A 项目下建 timeline → 404
  assertNotFound(await call("POST", `/api/projects/${projectId}/timelines`, { token: tokenB, body: { name: "x" } }));
});

test("非法输入返回 400（名称空 / 未知类型 / 起点越界）", async () => {
  const created = await call("POST", `/api/projects/${projectId}/timelines`, {
    token: tokenA,
    body: { name: "非法输入" },
  });
  const timelineId = (created.json() as { id: string }).id;

  assert.equal(
    (await call("POST", `/api/projects/${projectId}/timelines`, { token: tokenA, body: { name: "  " } })).statusCode,
    400,
  );
  // 未知轨道类型 → 400
  assert.equal(
    (await call("POST", `/api/timelines/${timelineId}/tracks`, { token: tokenA, body: { type: "effects", name: "x" } })).statusCode,
    400,
  );
  // 合法轨道 + 起点越界（超过当前 0s 时长）→ 400
  const track = await call("POST", `/api/timelines/${timelineId}/tracks`, {
    token: tokenA,
    body: { type: "video", name: "v" },
  });
  const trackId = (track.json() as { id: string }).id;
  const clip = await call("POST", `/api/timeline-tracks/${trackId}/clips`, {
    token: tokenA,
    body: { assetId: videoAssetId, startTime: 5, duration: 3 },
  });
  assert.equal(clip.statusCode, 400, clip.body);
});

test("Auto Timeline：按镜头自动生成（选中素材优先，无素材跳过）；无素材 400；越权 404", async () => {
  // 构造场景 → 分镜 → 两个镜头（6s / 4s）
  const scene = await call("POST", `/api/projects/${projectId}/scenes`, {
    token: tokenA,
    body: { name: "自动场景", description: "自动场景描述" },
  });
  const sceneId = (scene.json() as { id: string }).id;
  const sb = await call("POST", `/api/projects/${projectId}/storyboards`, {
    token: tokenA,
    body: { sceneId, description: "自动分镜", shotType: "medium", duration: 12 },
  });
  const sbId = (sb.json() as { id: string }).id;
  const shot1 = await call("POST", `/api/projects/${projectId}/shots`, {
    token: tokenA,
    body: { storyboardId: sbId, duration: 6 },
  });
  const shot1Id = (shot1.json() as { id: string }).id;
  const shot2 = await call("POST", `/api/projects/${projectId}/shots`, {
    token: tokenA,
    body: { storyboardId: sbId, duration: 4 },
  });
  const shot2Id = (shot2.json() as { id: string }).id;

  // shot1 绑定选中素材；shot2 无素材（应跳过）
  await call("PATCH", `/api/shots/${shot1Id}`, { token: tokenA, body: { videoAssetId } });

  const res = await call("POST", `/api/projects/${projectId}/timelines/auto`, {
    token: tokenA,
    body: { name: "自动成片", fps: 25 },
  });
  assert.equal(res.statusCode, 200, `自动生成应 200（实际 ${res.statusCode}：${res.body}）`);
  const body = res.json() as {
    timeline: { name: string; fps: number; duration: number; version: number };
    tracks: Array<{ type: string; name: string; order: number }>;
    clips: Array<{ assetId: string; shotId: string; startTime: number; duration: number; order: number }>;
    skipped: Array<{ shotId: string; reason: string }>;
  };
  assert.equal(body.timeline.name, "自动成片");
  assert.equal(body.timeline.fps, 25);
  assert.equal(body.timeline.duration, 6);
  assert.equal(body.timeline.version, 1);
  assert.equal(body.tracks.length, 1);
  assert.equal(body.tracks[0]!.type, "video");
  assert.equal(body.tracks[0]!.name, "视频轨");
  assert.equal(body.clips.length, 1);
  assert.equal(body.clips[0]!.assetId, videoAssetId);
  assert.equal(body.clips[0]!.shotId, shot1Id);
  assert.equal(body.clips[0]!.startTime, 0);
  assert.equal(body.clips[0]!.duration, 6);
  assert.equal(body.clips[0]!.order, 0);
  assert.deepEqual(
    body.skipped.map((s) => s.shotId),
    [shot2Id],
  );

  // 无任何镜头素材的项目 → 400
  const emptyProject = await call("POST", "/api/productions", {
    token: tokenA,
    body: { workspaceId, name: "空项目" },
  });
  const emptyProjectId = (emptyProject.json() as { id: string }).id;
  assert.equal(
    (await call("POST", `/api/projects/${emptyProjectId}/timelines/auto`, { token: tokenA, body: {} })).statusCode,
    400,
  );

  // 越权：B 用户对 A 项目自动生成 → 404
  assertNotFound(await call("POST", `/api/projects/${projectId}/timelines/auto`, { token: tokenB, body: {} }));
});

test("Render Task：ready → rendering + queued；未就绪 409；越权 404；任务视图可查", async () => {
  const created = await call("POST", `/api/projects/${projectId}/timelines`, {
    token: tokenA,
    body: { name: "渲染轴" },
  });
  const timelineId = (created.json() as { id: string }).id;
  const track = await call("POST", `/api/timelines/${timelineId}/tracks`, {
    token: tokenA,
    body: { type: "video", name: "v" },
  });
  const trackId = (track.json() as { id: string }).id;
  await call("POST", `/api/timeline-tracks/${trackId}/clips`, {
    token: tokenA,
    body: { assetId: videoAssetId, startTime: 0, duration: 5 },
  });

  // 未置 ready → 409
  const notReady = await call("POST", `/api/timelines/${timelineId}/render`, { token: tokenA });
  assert.equal(notReady.statusCode, 409, `未就绪应 409（实际 ${notReady.statusCode}）`);

  // 置 ready → render 200（任务 queued + 时间轴 rendering）
  await call("PATCH", `/api/timelines/${timelineId}`, { token: tokenA, body: { status: "ready" } });
  const rendered = await call("POST", `/api/timelines/${timelineId}/render`, { token: tokenA });
  assert.equal(rendered.statusCode, 200, rendered.body);
  const body = rendered.json() as {
    task: { id: string; kind: string; status: string };
    timeline: { status: string };
  };
  assert.equal(body.task.kind, "timeline_render");
  assert.equal(body.task.status, "queued");
  assert.equal(body.timeline.status, "rendering");

  // 任务白名单视图可查（GET /api/tasks/:id）
  const task = await call("GET", `/api/tasks/${body.task.id}`, { token: tokenA });
  assert.equal(task.statusCode, 200);
  assert.equal((task.json() as { kind: string; status: string }).status, "queued");

  // 越权 404
  assertNotFound(await call("POST", `/api/timelines/${timelineId}/render`, { token: tokenB }));
  assertNotFound(await call("GET", `/api/tasks/${body.task.id}`, { token: tokenB }));
});
