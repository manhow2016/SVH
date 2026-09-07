/**
 * GenerationService 集成测试（文档 §13：Image Prompt → 生成 → Asset 落库）。
 *
 * 真实临时库 + mockFetch：验证模型配置解析、供应商调用与资产/生成追踪数据。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, users, workspaces, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import type { ModelConfig, VideoProvider, VideoTask } from "@svh/providers";
import { DrizzleProductionRepository, ProductionService } from "@svh/production";
import { GenerationService } from "./generation-service";
import { ModelService } from "../settings/model-service";
import { SettingsService } from "../settings/service";

let dir: string;
let db: SVHDatabase;
let generation: GenerationService;
let production: ProductionService;
let projectId: string;
let userId: string;

/** 假视频适配器行为控制 */
const videoBehavior = {
  sequence: [] as VideoTask[],
  calls: [] as string[],
};

const fakeAdapter = (_input: { modelConfig: ModelConfig; providerId: string }): VideoProvider => ({
  id: "fake-video",
  async createTask() {
    videoBehavior.calls.push("create");
    return { providerTaskId: `pt-${videoBehavior.calls.length}` };
  },
  async getTask() {
    videoBehavior.calls.push("get");
    const next = videoBehavior.sequence.shift();
    if (!next) return { id: "", providerTaskId: "pt", status: "running" };
    return next;
  },
  async cancelTask() {
    videoBehavior.calls.push("cancel");
  },
});

function mockFetch(sequence: Array<Response | Error>): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    throw new Error("fetch failed（模拟网络异常）");
  }) as typeof fetch;
  return calls;
}

before(() => {
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
  const modelService = new ModelService(db);
  const settings = new SettingsService(db, { baseUrl: "", apiKey: "", model: "" }, modelService);
  generation = new GenerationService({
    db,
    settings,
    production,
    videoAdapterFactory: fakeAdapter,
    pollIntervalMs: 10,
  });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("generateImage：解析默认 image 模型 → 调用 /images/generations → 资产落库（含来源追踪）", async () => {
  const ws = db.select().from(workspaces).get()!;
  projectId = (await production.createProject({ workspaceId: ws.id, name: "图片项目" })).id;
  const calls = mockFetch([
    new Response(
      JSON.stringify({
        created: 999,
        data: [{ url: "https://cdn.example.com/shot-001.png" }],
      }),
      { status: 200 },
    ),
  ]);

  const result = (await generation.generateImage({
    projectId,
    userId,
    prompt: "雨夜的霓虹街头，国风",
  })) as { asset: { id: string; url?: string; generation?: Record<string, unknown> } };

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    "默认 image 模型应为火山 Seedream（sortOrder 最小）",
  );
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.equal(body.model, "doubao-seedream-4-0-250828");
  assert.equal(body.prompt, "雨夜的霓虹街头，国风");
  assert.equal(body.n, 1);

  assert.equal(result.asset.url, "https://cdn.example.com/shot-001.png");
  assert.equal(result.asset.generation?.modelId, "doubao-seedream-4-0-250828");
  assert.equal(result.asset.generation?.providerId, "volcengine", "来源追踪应记录目录供应商 id");
  assert.equal(result.asset.generation?.prompt, "雨夜的霓虹街头，国风");

  const assets = await production.listAssets(projectId, "image");
  assert.equal(assets.length, 1);
  assert.equal(assets[0]?.name, "雨夜的霓虹街头，国风");
});

test("generateImage：dashscope 模型路由到原生 multimodal-generation 接口并解析 image URL", async () => {
  const calls = mockFetch([
    new Response(
      JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://cdn.dashscope.example/b.png" }] } }] },
        request_id: "req-1",
      }),
      { status: 200 },
    ),
  ]);
  await generation.generateImage({
    projectId,
    userId,
    prompt: "赛博朋克",
    modelName: "wanx2.1-t2i-turbo",
    size: "1024x1024",
  });
  const body = JSON.parse(calls[0]!.body) as {
    model: string;
    input: { messages: Array<{ content: Array<{ text: string }> }> };
    parameters: { size?: string };
  };
  assert.equal(body.model, "wanx2.1-t2i-turbo");
  assert.equal(body.input.messages[0]!.content[0]!.text, "赛博朋克");
  assert.equal(body.parameters.size, "1024*1024"); // OpenAI 风格 x → 原生 *
  assert.equal(
    calls[0]!.url,
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
  const images = await production.listAssets(projectId, "image");
  assert.equal(images.length, 2);
});

test("generateImage：prompt 为空拒绝；供应商 401 → 502 IMAGE_PROVIDER_ERROR（信息透传）", async () => {
  await assert.rejects(
    generation.generateImage({ projectId, userId, prompt: "   " }),
    /prompt is required/,
  );
  mockFetch([new Response("unauthorized", { status: 401 })]);
  await assert.rejects(
    generation.generateImage({ projectId, userId, prompt: "测试" }),
    (err: Error & { code?: string; status?: number }) => {
      assert.equal(err.code, "IMAGE_PROVIDER_ERROR");
      assert.equal(err.status, 502);
      assert.match(err.message, /401/);
      assert.match(err.message, /API Key/);
      return true;
    },
  );
});

// ================= 视频任务（Phase 8） =================

/** 轮询等待任务进入目标状态 */
async function waitTaskStatus(id: string, statuses: string[], timeoutMs = 5000): Promise<{ status: string; outputUrl?: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = generation.getTask(id);
    if (statuses.includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待任务状态超时（当前 ${generation.getTask(id).status}）`);
}

test("startVideoTask：异步轮询至 completed → 视频资产落库（含 taskId 追踪）", async () => {
  videoBehavior.sequence = [
    { id: "", providerTaskId: "pt-1", status: "queued" },
    { id: "", providerTaskId: "pt-1", status: "running" },
    {
      id: "",
      providerTaskId: "pt-1",
      status: "completed",
      outputUrl: "https://cdn.example.com/video-001.mp4",
    },
  ];
  const task = await generation.startVideoTask({
    projectId,
    userId,
    prompt: "雨夜街头奔跑的武侠",
    modelName: "wanx2.1-t2v-turbo",
  });
  assert.equal(task.status, "queued");

  const done = await waitTaskStatus(task.id, ["completed", "failed"]);
  assert.equal(done.status, "completed");
  assert.equal(done.outputUrl, "https://cdn.example.com/video-001.mp4");

  const assets = await production.listAssets(projectId, "video");
  assert.equal(assets.length, 1);
  assert.equal(assets[0]?.url, "https://cdn.example.com/video-001.mp4");
  assert.equal(assets[0]?.generation?.providerId, "dashscope");
  assert.equal(assets[0]?.generation?.taskId, task.id);
  assert.equal(assets[0]?.generation?.modelId, "wanx2.1-t2v-turbo");
});

test("startVideoTask：provider createTask 抛错 → 502 VIDEO_PROVIDER_ERROR（信息透传，不落任务）", async () => {
  const settings = new SettingsService(db, { baseUrl: "", apiKey: "", model: "" }, new ModelService(db));
  const svc = new GenerationService({
    db,
    settings,
    production,
    videoAdapterFactory: () => ({
      id: "boom-video",
      async createTask() {
        throw new Error("dashscope 401 InvalidApiKey");
      },
      async getTask() {
        return { id: "", providerTaskId: "", status: "running" } as VideoTask;
      },
      async cancelTask() {},
    }),
    pollIntervalMs: 10,
  });
  await assert.rejects(
    svc.startVideoTask({ projectId, userId, prompt: "测试视频" }),
    (err: Error & { code?: string; status?: number }) => {
      assert.equal(err.code, "VIDEO_PROVIDER_ERROR");
      assert.equal(err.status, 502);
      assert.match(err.message, /InvalidApiKey/);
      return true;
    },
  );
});

test("startVideoTask：模型失败 → 任务 failed，不产生资产", async () => {  videoBehavior.sequence = [
    { id: "", providerTaskId: "pt-2", status: "running" },
    { id: "", providerTaskId: "pt-2", status: "failed", error: "内容审核未通过" },
  ];
  const task = await generation.startVideoTask({ projectId, userId, prompt: "开坦克", modelName: "wanx2.1-t2v-turbo" });
  const done = await waitTaskStatus(task.id, ["failed"]);
  assert.equal(done.status, "failed");
  assert.equal((await production.listAssets(projectId, "video")).length, 1, "只有成功任务写资产");
});

test("cancelTask：运行中任务可取消并停止轮询", async () => {
  // getTask 永远返回 running（sequence 为空 → fake 返回 running）
  videoBehavior.sequence = [];
  const task = await generation.startVideoTask({ projectId, userId, prompt: "无限长度的视频" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const cancelled = await generation.cancelTask(task.id);
  assert.equal(cancelled, undefined);
  const view = generation.getTask(task.id);
  assert.equal(view.status, "cancelled");
  assert.ok(videoBehavior.calls.includes("cancel"), "应通知供应商取消");
  // 终态后取消应被拒绝
  await assert.rejects(generation.cancelTask(task.id), /终态/);
});
