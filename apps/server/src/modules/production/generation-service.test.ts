/**
 * GenerationService 入队语义测试（Task 6：server 不再调用 Provider）。
 *
 * 真实临时库：验证「校验 + 模型解析即时反馈 → production_tasks 落 queued 行 +
 * 完整 payload（worker 执行参数）→ 视图不泄漏队列内部列」。
 * Provider 错误路径已移入 worker（进 task.error），由 apps/worker 测试覆盖，
 * 旧 mockFetch/轮询/502 用例全部删除。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase, productionTasks, users, workflows, workspaces, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import { DrizzleProductionRepository, DefaultPromptComposer, ProductionService } from "@svh/production";
import { GenerationService, type ProductionTaskView } from "./generation-service";
import { ModelService } from "../settings/model-service";
import { SettingsService } from "../settings/service";

let dir: string;
let db: SVHDatabase;
let generation: GenerationService;
let settings: SettingsService;
let production: ProductionService;
let projectId: string;
let userId: string;

/** ServerError 形状断言器（code + HTTP status 双要素） */
const serverErr =
  (code: string, status: number) =>
  (err: unknown): boolean => {
    const e = err as Error & { code?: string; status?: number };
    assert.equal(e.code, code, `错误码应为 ${code}（实际 ${e.code}）`);
    assert.equal(e.status, status, `HTTP 状态应为 ${status}（实际 ${e.status}）`);
    return true;
  };

/** 读任务行的 payload JSON（worker 执行参数，视图不可见，仅测试直查 DB） */
function payloadOf(taskId: string): Record<string, unknown> {
  const row = db.select().from(productionTasks).where(eq(productionTasks.id, taskId)).get();
  assert.ok(row, `任务行 ${taskId} 应已落库`);
  assert.ok(row.payload, "payload 列必须完整写入（worker 认领条件）");
  return JSON.parse(row.payload) as Record<string, unknown>;
}

/** 视图对内部列的泄漏检查 */
function assertNoQueueLeak(view: ProductionTaskView): void {
  for (const key of ["payload", "claimedBy", "heartbeatAt"]) {
    assert.ok(!(key in view), `任务视图不得外泄内部列 ${key}`);
  }
}

/** 新建零配置用户：无任何 provider Key（envDefaults 亦为空）→ 空 Key 分支可达 */
function freshUser(): string {
  const id = randomId("usr");
  db.insert(users)
    .values({
      id,
      username: `nokey-${id}`,
      email: `${id}@test.local`,
      passwordHash: "x",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-generation-"));
  db = createDatabase(join(dir, "test.db"));
  userId = randomId("usr");
  db.insert(users)
    .values({
      id: userId,
      username: "gen-user",
      email: "gen-user@test.local",
      passwordHash: "x",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const wsId = randomId("ws");
  db.insert(workspaces)
    .values({
      id: wsId,
      name: "gen-ws",
      rootPath: join(dir, wsId),
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  production = new ProductionService(new DrizzleProductionRepository(db));
  projectId = (await production.createProject({ workspaceId: wsId, name: "入队测试项目" })).id;
  // Task 1 透传用例依赖 `production_tasks.workflow_id` 的外部键（引用 workflows.id）。
  // 夹具创建一条真实工作流（id=wfl_1），否则按 brief 的固定字面量入队会触发 FK 约束。
  db.insert(workflows)
    .values({
      id: "wfl_1",
      projectId,
      userId,
      status: "ready",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  settings = new SettingsService(db, { baseUrl: "", apiKey: "", model: "" }, new ModelService(db));
  // 夹具用户配置双供应商 Key：Task 6 修复轮 I2 起「空 Key」入队前即 400，
  // 成功用例必须先有 Key（Key 落库也验证 payload 透传真实解析结果）
  await settings.updateModelSettings(userId, {
    providers: {
      volcengine: { apiKey: "sk-test-volc" },
      dashscope: { apiKey: "sk-test-dash" },
    },
  });
  // V0.3 Phase 2：注入 Prompt Composer（可选），图片/视频统一经 Prompt Composer 组合提示词
  generation = new GenerationService({
    db,
    settings,
    production,
    promptComposer: new DefaultPromptComposer(),
  });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ================= 图片入队 =================

test("enqueueImage：prompt 空白 → INVALID_INPUT 400，且不入队", async () => {
  const before0 = db.select().from(productionTasks).all().length;
  await assert.rejects(
    generation.enqueueImage({ projectId, userId, prompt: "   " }),
    serverErr("INVALID_INPUT", 400),
  );
  assert.equal(db.select().from(productionTasks).all().length, before0, "校验失败不得产生任务行");
});

test("enqueueImage：成功入队 → queued 视图 + payload 字段齐（providerId/model/assetName/prompt/size）", async () => {
  const view = await generation.enqueueImage({
    projectId,
    userId,
    prompt: "雨夜的霓虹街头，国风",
    size: "1024x1024",
  });
  assert.equal(view.kind, "image");
  assert.equal(view.status, "queued");
  assert.equal(view.projectId, projectId);
  assertNoQueueLeak(view);

  const p = payloadOf(view.id);
  assert.equal(p.v, 1, "payload 版本应为 v1");
  assert.equal(p.prompt, "雨夜的霓虹街头，国风");
  assert.equal(
    p.composedPrompt,
    "雨夜的霓虹街头，国风",
    "无项目风格/镜头上下文时 composedPrompt 等同于用户描述（经 Prompt Composer 组合）",
  );
  assert.equal(typeof p.promptMetadata, "object", "V0.3 Phase 2：payload 携带组合来源元数据");
  assert.equal((p.promptMetadata as Record<string, unknown>).templateId, "default");
  assert.equal(p.size, "1024x1024");
  assert.equal(p.model, "doubao-seedream-4-0-250828", "默认 image 模型 = 火山 Seedream（sortOrder 最小）");
  assert.equal(p.providerId, "volcengine");
  assert.equal(p.assetName, "雨夜的霓虹街头，国风", "assetName 默认取 prompt 前 40 字");
  assert.equal(p.apiKey, "sk-test-volc", "apiKey 由 server 解析透传（夹具用户 Key）");
  assert.equal(typeof p.baseUrl, "string");
  assert.equal(view.providerId, "volcengine", "视图 providerId 有值（供任务条展示）");

  const row = db.select().from(productionTasks).where(eq(productionTasks.id, view.id)).get();
  assert.equal(row!.providerId, "volcengine", "行上冗余 providerId 列供任务视图展示");
});

test("enqueueImage：dashscope 目录模型 → payload.providerId === \"dashscope\"", async () => {
  const view = await generation.enqueueImage({
    projectId,
    userId,
    prompt: "赛博朋克",
    modelName: "wanx2.1-t2i-turbo",
    size: "1024x1024",
  });
  const p = payloadOf(view.id);
  assert.equal(p.providerId, "dashscope");
  assert.equal(p.model, "wanx2.1-t2i-turbo");
});

test("enqueueImage：provider 未配置 API Key → INVALID_INPUT 400（修复轮 I2：即时反馈，不入库）", async () => {
  const bare = freshUser();
  const before0 = db.select().from(productionTasks).all().length;
  await assert.rejects(
    generation.enqueueImage({ projectId, userId: bare, prompt: "有效描述但没 Key" }),
    (err: unknown) => {
      const e = err as Error & { code?: string; status?: number };
      assert.equal(e.code, "INVALID_INPUT");
      assert.equal(e.status, 400);
      assert.match(e.message, /volcengine 未配置 API Key/, "文案须点明供应商，便于用户修复");
      return true;
    },
  );
  assert.equal(db.select().from(productionTasks).all().length, before0, "空 Key 不得产生 queued 行");
});

// ================= 视频入队 =================

test("enqueueVideo：prompt 与 imageUrl 均空 → INVALID_INPUT 400", async () => {
  await assert.rejects(
    generation.enqueueVideo({ projectId, userId, prompt: "  " }),
    serverErr("INVALID_INPUT", 400),
  );
  await assert.rejects(generation.enqueueVideo({ projectId, userId }), serverErr("INVALID_INPUT", 400));
});

test("enqueueVideo：成功入队 → queued + duration/resolution 透传；图生视频缺 prompt 仍合法", async () => {
  const t2v = await generation.enqueueVideo({
    projectId,
    userId,
    prompt: "雨夜街头奔跑的武侠",
    modelName: "wanx2.1-t2v-turbo",
    duration: 5,
    resolution: "1080P",
  });
  assert.equal(t2v.kind, "video");
  assert.equal(t2v.status, "queued");
  assertNoQueueLeak(t2v);
  const p1 = payloadOf(t2v.id);
  assert.equal(p1.providerId, "dashscope");
  assert.equal(p1.model, "wanx2.1-t2v-turbo");
  assert.equal(p1.prompt, "雨夜街头奔跑的武侠");
  assert.equal(p1.duration, 5);
  assert.equal(p1.resolution, "1080P");
  assert.equal(p1.assetName, "雨夜街头奔跑的武侠");

  // 图生视频：无 prompt 合法（worker 侧 payload 校验对 video 不要求 prompt）
  const i2v = await generation.enqueueVideo({ projectId, userId, imageUrl: "https://x/ref.png" });
  const p2 = payloadOf(i2v.id);
  assert.equal(p2.imageUrl, "https://x/ref.png");
  assert.ok(!("prompt" in p2), "prompt 空不落键（JSON 序列化丢 undefined 键）");
  assert.equal(p2.assetName, "生成视频", "无 prompt 时用默认资产名");
});

test("enqueueVideo：provider 未配置 API Key → INVALID_INPUT 400（修复轮 I2：即时反馈，不入库）", async () => {
  const bare = freshUser();
  const before0 = db.select().from(productionTasks).all().length;
  await assert.rejects(
    generation.enqueueVideo({ projectId, userId: bare, prompt: "有效描述但没 Key", modelName: "wanx2.1-t2v-turbo" }),
    (err: unknown) => {
      const e = err as Error & { code?: string; status?: number };
      assert.equal(e.code, "INVALID_INPUT");
      assert.equal(e.status, 400);
      assert.match(e.message, /dashscope 未配置 API Key/);
      return true;
    },
  );
  assert.equal(db.select().from(productionTasks).all().length, before0, "空 Key 不得产生 queued 行");
});

// ================= getTask / cancelTask =================

test("getTask：不存在 → NOT_FOUND 404", () => {
  assert.throws(() => generation.getTask("ptk-not-exists"), serverErr("NOT_FOUND", 404));
});

test("cancelTask：queued → cancelled（worker 下轮收敛）；再取消 → CONFLICT 409", async () => {
  const view = await generation.enqueueImage({ projectId, userId, prompt: "待取消任务" });
  await generation.cancelTask(view.id);
  assert.equal(generation.getTask(view.id).status, "cancelled");
  await assert.rejects(generation.cancelTask(view.id), serverErr("CONFLICT", 409));
});

test("cancelTask：running（worker 已认领、心跳新鲜）→ 置 cancelled 且不动认领列", async () => {
  const id = randomId("ptk");
  const now = new Date();
  db.insert(productionTasks)
    .values({
      id,
      projectId,
      userId,
      kind: "video",
      providerId: "dashscope",
      status: "running",
      claimedBy: "wkr-1",
      heartbeatAt: Date.now(),
      payload: JSON.stringify({ v: 1, prompt: "x", providerId: "dashscope", model: "m", baseUrl: "", apiKey: "k", assetName: "a" }),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await generation.cancelTask(id);
  const row = db.select().from(productionTasks).where(eq(productionTasks.id, id)).get();
  assert.equal(row!.status, "cancelled");
  assert.equal(row!.claimedBy, "wkr-1", "server 只标记取消，清理由 worker 观察收敛（不触供应商）");
  assertNoQueueLeak(generation.getTask(id)); // 修复轮 Minor3：取消后视图仍守白名单
});

test("cancelTask：completed 终态 → CONFLICT 409", async () => {
  const id = randomId("ptk");
  const now = new Date();
  db.insert(productionTasks)
    .values({
      id,
      projectId,
      userId,
      kind: "image",
      status: "completed",
      outputUrl: "https://x/a.png",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await assert.rejects(generation.cancelTask(id), serverErr("CONFLICT", 409));
});

// ================= 工作流入队透传（Task 1） =================

test("enqueueImage：透传 workflowId/nodeId/storyboardId 落列，assetName 可覆盖", async () => {
  const view = await generation.enqueueImage({
    projectId, userId, prompt: "一只白鹤掠过水面",
    workflowId: "wfl_1", nodeId: "images", storyboardId: "sto_1", assetName: "分镜1·画面",
  });
  const row = db.select().from(productionTasks).where(eq(productionTasks.id, view.id)).get();
  assert.equal(row!.workflowId, "wfl_1");
  assert.equal(row!.nodeId, "images");
  const p = payloadOf(view.id);
  assert.equal(p.storyboardId, "sto_1");
  assert.equal(p.assetName, "分镜1·画面", "assetName 应覆盖默认值");
  assert.equal(view.status, "queued");
});

test("listTasksByNode：返回该节点任务，从 payload 解析 storyboardId 且按创建升序", async () => {
  // 为与上一用例隔离（共享 DB），本用例用独立 nodeId "scene"，避免与 "images" 任务互相污染
  await generation.enqueueImage({ projectId, userId, prompt: "a", workflowId: "wfl_1", nodeId: "scene", storyboardId: "sto_a" });
  await generation.enqueueImage({ projectId, userId, prompt: "b", workflowId: "wfl_1", nodeId: "scene", storyboardId: "sto_b" });
  await generation.enqueueImage({ projectId, userId, prompt: "c" }); // 无 workflowId/nodeId，不应被返回
  const tasks = generation.listTasksByNode("wfl_1", "scene");
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.storyboardId).sort(), ["sto_a", "sto_b"]);
});
