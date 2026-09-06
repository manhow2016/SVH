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
import { ProductionService } from "@svh/production";
import { DrizzleProductionRepository } from "./repository";
import { GenerationService } from "./generation-service";
import { ModelService } from "../settings/model-service";
import { SettingsService } from "../settings/service";

let dir: string;
let db: SVHDatabase;
let generation: GenerationService;
let production: ProductionService;
let projectId: string;
let userId: string;

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
  generation = new GenerationService({ settings, production });
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
  assert.equal(result.asset.generation?.providerId, "openai-compatible");
  assert.equal(result.asset.generation?.prompt, "雨夜的霓虹街头，国风");

  const assets = await production.listAssets(projectId, "image");
  assert.equal(assets.length, 1);
  assert.equal(assets[0]?.name, "雨夜的霓虹街头，国风");
});

test("generateImage：显式指定 modelName 时使用该模型（dashscope 百炼）", async () => {
  const calls = mockFetch([
    new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/b.png" }] }), { status: 200 }),
  ]);
  await generation.generateImage({
    projectId,
    userId,
    prompt: "赛博朋克",
    modelName: "wanx2.1-t2i-turbo",
  });
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.equal(body.model, "wanx2.1-t2i-turbo");
  assert.equal(
    calls[0]!.url,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations",
  );
  const images = await production.listAssets(projectId, "image");
  assert.equal(images.length, 2);
});

test("generateImage：prompt 为空拒绝；供应商 401 抛错", async () => {
  await assert.rejects(
    generation.generateImage({ projectId, userId, prompt: "   " }),
    /prompt is required/,
  );
  mockFetch([new Response("unauthorized", { status: 401 })]);
  await assert.rejects(
    generation.generateImage({ projectId, userId, prompt: "测试" }),
    /401/,
  );
});
