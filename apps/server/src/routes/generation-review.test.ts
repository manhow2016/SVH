/**
 * 生成审核 / 版本路由测试（V0.3 Phase 5）。
 *
 * 冒烟钉契约面：创建/列表生成记录、approve/reject（审核状态迁移）。
 * approve 前的「已完成 + 产出资产」前置通过 probe 直改 generation_records 行，
 * 避免依赖 worker 真实生成（本测试不启 worker）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createDatabase, generationRecords, productionAssets, productionProjects, productionTasks, users, type SVHDatabase } from "@svh/database";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
let probe: SVHDatabase;
let token: string;
let projectId: string;

async function call(method: "GET" | "POST" | "PUT", url: string, opts: { body?: InjectOptions["payload"] } = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: opts.body });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-review-route-"));
  const databaseUrl = join(dir, "test.db");
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "review-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });
  probe = createDatabase(databaseUrl);

  const reg = await call("POST", "/api/auth/register", {
    body: { username: "review-user", email: "review@smoke.local", password: "Smoke12345" },
  });
  assert.equal(reg.statusCode, 201);
  const login = await call("POST", "/api/auth/login", {
    body: { identifier: "review-user", password: "Smoke12345" },
  });
  token = (login.json() as { token: string }).token;

  const wsRes = await call("POST", "/api/workspaces", { body: { name: "review-ws" } });
  const workspaceId = (wsRes.json() as { id: string }).id;
  const pjRes = await call("POST", "/api/productions", { body: { workspaceId, name: "审核项目" } });
  projectId = (pjRes.json() as { id: string }).id;
});

after(async () => {
  try {
    probe?.$client.close();
    if (app) await app.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("创建生成记录 + 按项目列出", async () => {
  const res = await call("POST", `/api/projects/${projectId}/generations`, {
    body: { kind: "image", prompt: "测试画面" },
  });
  assert.equal(res.statusCode, 200, `创建生成记录应 200（实际 ${res.statusCode}：${res.body}）`);
  const record = res.json() as { id: string; version: number; reviewStatus: string };
  assert.equal(record.version, 1);
  assert.equal(record.reviewStatus, "pending");

  const list = await call("GET", `/api/projects/${projectId}/generations`);
  const items = list.json() as Array<{ id: string }>;
  assert.ok(items.some((r) => r.id === record.id));
});

test("approve：需先置为已完成 + 产出资产；approve 后 reviewStatus=approved, selected=true", async () => {
  // 重新创建一个未完成的记录
  const res = await call("POST", `/api/projects/${projectId}/generations`, {
    body: { kind: "image", prompt: "待审核画面" },
  });
  const record = res.json() as { id: string };

  // 未完成 → 409
  const beforeApprove = await call("POST", `/api/generations/${record.id}/approve`);
  assert.equal(beforeApprove.statusCode, 409, "未完成的生成不可通过审核");

  // probe 直改成已完成 + 产出资产（模拟 worker 完成）
  probe
    .update(generationRecords)
    .set({ status: "completed", outputAssetId: "ast_mock_1" })
    .where(eq(generationRecords.id, record.id))
    .run();

  const approve = await call("POST", `/api/generations/${record.id}/approve`);
  assert.equal(approve.statusCode, 200);
  const after = approve.json() as { reviewStatus: string; selected: boolean };
  assert.equal(after.reviewStatus, "approved");
  assert.equal(after.selected, true);
});

test("reject：标记 rejected，保留记录", async () => {
  const res = await call("POST", `/api/projects/${projectId}/generations`, {
    body: { kind: "image", prompt: "被拒画面" },
  });
  const record = res.json() as { id: string };
  probe
    .update(generationRecords)
    .set({ status: "completed", outputAssetId: "ast_rej" })
    .where(eq(generationRecords.id, record.id))
    .run();

  const reject = await call("POST", `/api/generations/${record.id}/reject`);
  assert.equal(reject.statusCode, 200);
  const after = reject.json() as { reviewStatus: string; selected: boolean };
  assert.equal(after.reviewStatus, "rejected");
  assert.equal(after.selected, false);
});

test("batch：按 scene 批量生成，登记生成记录且提示词含场景/角色/风格上下文", async () => {
  // 配置图片模型（volcengine + apiKey），否则入队 400
  const put = await call("PUT", "/api/settings", {
    body: { providers: { volcengine: { apiKey: "sk-batch-test" } } },
  });
  assert.equal(put.statusCode, 200, `配置模型设置应 200（实际 ${put.body}）`);

  // 建角色 + 场景 + 分镜 + 镜头
  const chr = await call("POST", `/api/projects/${projectId}/characters`, {
    body: { name: "风灵", description: "女主角", appearance: { gender: "女", hairstyle: "长发", clothing: "白蓝长袍" } },
  });
  const chrId = (chr.json() as { id: string }).id;
  const scene = await call("POST", `/api/projects/${projectId}/scenes`, {
    body: { name: "飞檐夜色", description: "月光下飞檐", location: "皇宫", time: "夜晚", characters: [chrId] },
  });
  const sceneId = (scene.json() as { id: string }).id;
  const sb = await call("POST", `/api/projects/${projectId}/storyboards`, {
    body: { sceneId, description: "分镜", duration: 6, shotType: "medium_shot" },
  });
  const sbId = (sb.json() as { id: string }).id;
  const shot = await call("POST", `/api/projects/${projectId}/shots`, {
    body: { storyboardId: sbId, duration: 3, action: "挥剑", framing: "特写" },
  });
  const shotId = (shot.json() as { id: string }).id;

  const batch = await call("POST", `/api/projects/${projectId}/generations/batch`, {
    body: { scope: { sceneId } },
  });
  assert.equal(batch.statusCode, 200, `批量生成应 200（实际 ${batch.statusCode}：${batch.body}）`);
  const result = batch.json() as { items: Array<{ id: string; taskId?: string }> };
  assert.ok(result.items.length >= 1, "应至少生成一个任务");
  assert.ok(result.items.every((i) => i.taskId), "每个计划项都应有 taskId");

  // 登记了生成记录，且提示词包含角色锚点 + 场景 + 风格上下文
  const records = await call("GET", `/api/shots/${shotId}/generations`);
  const recs = records.json() as Array<{ prompt: string; kind: string; reviewStatus: string }>;
  assert.ok(recs.length >= 1, "应为该镜头登记生成记录");
  const img = recs.find((r) => r.kind === "image");
  assert.ok(img, "应有 image 生成记录");
  assert.equal(img!.reviewStatus, "pending");
  // 角色 anchor（由 appearance 组装）与场景描述应进入最终 Prompt
  assert.match(img!.prompt, /风灵/, "Prompt 应含角色（Anchor 注入）");
  assert.match(img!.prompt, /月光下飞檐/, "Prompt 应含场景描述");
});

test("regenerate：基于既有图像记录创建 v+1 并入队，支持覆盖 prompt", async () => {
  await call("PUT", "/api/settings", { body: { providers: { volcengine: { apiKey: "sk-regen" } } } });
  const scene = await call("POST", `/api/projects/${projectId}/scenes`, { body: { name: "S", description: "d" } });
  const sceneId = (scene.json() as { id: string }).id;
  const sb = await call("POST", `/api/projects/${projectId}/storyboards`, { body: { sceneId, description: "sb", duration: 6, shotType: "medium_shot" } });
  const sbId = (sb.json() as { id: string }).id;
  const shot = await call("POST", `/api/projects/${projectId}/shots`, { body: { storyboardId: sbId, duration: 3 } });
  const shotId = (shot.json() as { id: string }).id;

  const rec = await call("POST", `/api/projects/${projectId}/generations`, { body: { kind: "image", prompt: "v1", shotId } });
  const recId = (rec.json() as { id: string }).id;
  probe.update(generationRecords).set({ status: "completed", outputAssetId: "ast_1" }).where(eq(generationRecords.id, recId)).run();

  const regen = await call("POST", `/api/generations/${recId}/regenerate`, { body: { prompt: "v2 修改后" } });
  assert.equal(regen.statusCode, 200, `regenerate 应 200（实际 ${regen.statusCode}：${regen.body}）`);
  const body = regen.json() as {
    record: { prompt: string; kind: string; version: number; shotId?: string };
    task: { id: string };
  };
  assert.equal(body.record.kind, "image");
  assert.equal(body.record.prompt, "v2 修改后");
  assert.equal(body.record.version, 2, "同镜头版本号 v+1");
  assert.equal(body.record.shotId, shotId);
  assert.ok(body.task.id, "应入队新任务");
});

test("对账：queued 记录 + 任务已完成 + 资产在案 → 列表时自动补写 completed/outputAssetId", async () => {
  const taskId = "ptk_recon_1";
  // 直插任务行（任务已完成）与配套资产（generation.taskId 匹配）
  probe
    .insert(productionTasks)
    .values({
      id: taskId,
      projectId,
      userId: (probe.select({ id: users.id }).from(users).limit(1).get() as { id: string }).id,
      kind: "image",
      providerId: "volcengine",
      status: "completed",
      progress: 100,
      outputUrl: "https://example.com/recon.png",
      payload: JSON.stringify({ prompt: "对账" }),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const project = probe.select().from(productionProjects).where(eq(productionProjects.id, projectId)).get()!;
  const assetId = "ast_recon_1";
  probe
    .insert(productionAssets)
    .values({
      id: assetId,
      projectId,
      workspaceId: project.workspaceId,
      userId: project.userId,
      type: "image",
      name: "对账产出",
      url: "https://example.com/recon.png",
      generation: { providerId: "volcengine", taskId },
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  // 生成记录：queued + taskId（模拟 worker 回写失败的残留）
  const recordId = "gen_recon_1";
  probe
    .insert(generationRecords)
    .values({
      id: recordId,
      projectId,
      kind: "image",
      version: 1,
      prompt: "对账",
      status: "queued",
      reviewStatus: "pending",
      selected: false,
      taskId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  // 列表端点应触发对账：queued → completed + outputAssetId
  const res = await call("GET", `/api/projects/${projectId}/generations`);
  assert.equal(res.statusCode, 200);
  const records = res.json() as Array<{ id: string; status: string; outputAssetId?: string }>;
  const reconciled = records.find((r) => r.id === recordId);
  assert.ok(reconciled, "记录应在列表中");
  assert.equal(reconciled?.status, "completed", "对账应补写 completed");
  assert.equal(reconciled?.outputAssetId, assetId, "对账应挂上产出资产");
});

test("Phase B：批量生成时按分镜出场角色解析参考资产 URL 并透传入 payload", async () => {
  // 参考资产
  const asset = await call("POST", `/api/projects/${projectId}/assets`, {
    body: { type: "image", name: "主角参考", url: "https://example.com/ref.png" },
  });
  const assetId = (asset.json() as { id: string }).id;
  // 角色 + 参考资产
  const character = await call("POST", `/api/projects/${projectId}/characters`, {
    body: { name: "主角", description: "d", referenceAssetId: assetId },
  });
  const characterId = (character.json() as { id: string }).id;
  // 场景（含出场角色）→ 分镜 → 镜头
  const scene = await call("POST", `/api/projects/${projectId}/scenes`, {
    body: { name: "场景", description: "d", characters: [characterId] },
  });
  const sceneId = (scene.json() as { id: string }).id;
  const storyboard = await call("POST", `/api/projects/${projectId}/storyboards`, {
    body: { sceneId, description: "分镜", duration: 5, shotType: "wide" },
  });
  const storyboardId = (storyboard.json() as { id: string }).id;
  const shot = await call("POST", `/api/projects/${projectId}/shots`, {
    body: { storyboardId, duration: 3, action: "主角走过" },
  });
  const shotId = (shot.json() as { id: string }).id;

  const batch = await call("POST", `/api/projects/${projectId}/generations/batch`, {
    body: { scope: { shotIds: [shotId] } },
  });
  assert.equal(batch.statusCode, 200);
  const items = (batch.json() as { items: Array<{ id: string; taskId?: string }> }).items;
  const tasks = items.map((item) => item.taskId).filter((v): v is string => Boolean(v));
  assert.ok(tasks.length > 0, "应入队任务");
  // 任务 payload 应含参考图 URL（读取 probe 直查，避免视图外泄检查挡住）
  const row = probe.select().from(productionTasks).where(eq(productionTasks.id, tasks[0]!)).get()!;
  assert.ok(row.payload?.includes("referenceImageUrls"), "payload 应含 referenceImageUrls");
  assert.ok(row.payload!.includes("https://example.com/ref.png"), "payload 应含参考资产 URL");
});

test("batch-review：按 scope 一键通过各镜头最新已完成记录", async () => {
  // 场景 → 分镜 → 镜头 ×2（同一分镜）
  const scene = await call("POST", `/api/projects/${projectId}/scenes`, { body: { name: "场景D", description: "d" } });
  const sceneId = (scene.json() as { id: string }).id;
  const sb = await call("POST", `/api/projects/${projectId}/storyboards`, {
    body: { sceneId, description: "分镜D", duration: 8, shotType: "wide" },
  });
  const storyboardId = (sb.json() as { id: string }).id;
  const shot1 = await call("POST", `/api/projects/${projectId}/shots`, { body: { storyboardId, duration: 3 } });
  const shot2 = await call("POST", `/api/projects/${projectId}/shots`, { body: { storyboardId, duration: 3 } });
  const shotId1 = (shot1.json() as { id: string }).id;
  const shotId2 = (shot2.json() as { id: string }).id;

  const rec1 = await call("POST", `/api/projects/${projectId}/generations`, { body: { kind: "image", prompt: "D1", shotId: shotId1 } });
  const rec2 = await call("POST", `/api/projects/${projectId}/generations`, { body: { kind: "image", prompt: "D2", shotId: shotId2 } });
  const recId1 = (rec1.json() as { id: string }).id;
  const recId2 = (rec2.json() as { id: string }).id;
  // 置为已完成（允许审核前置）
  probe.update(generationRecords).set({ status: "completed", outputAssetId: "ast_d" }).where(eq(generationRecords.id, recId1)).run();
  probe.update(generationRecords).set({ status: "completed", outputAssetId: "ast_d" }).where(eq(generationRecords.id, recId2)).run();

  const review = await call("POST", `/api/projects/${projectId}/generations/batch-review`, {
    body: { scope: { storyboardId }, action: "approve" },
  });
  assert.equal(review.statusCode, 200);
  const body = review.json() as { affected: number; results: Array<{ shotId: string; reviewStatus: string }> };
  assert.equal(body.affected, 2, "两个镜头应各通过一条");
  assert.ok(body.results.every((r) => r.reviewStatus === "approved"));
  const after = probe.select().from(generationRecords).where(eq(generationRecords.id, recId1)).get()!;
  assert.equal(after.reviewStatus, "approved");
});
