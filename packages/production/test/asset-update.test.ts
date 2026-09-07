/**
 * updateAssetFields 窄更新测试（资产本地化转存，设计文档 §3 / §4）。
 *
 * 双实现同测：真 SQLite 临时库（drizzle 适配器，交付路径）与内存假仓储
 * （server 测试基础设施），断言二者语义一致——
 * 仅 patch 中出现的键被写、null 显式清列、无键 patch 判调用方 bug、不存在 id 抛同款 NotFound。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, users, workspaces, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import { DrizzleProductionRepository } from "../src/sqlite-repository";
import { ProductionError, ProductionService } from "../src/index";
import { FakeProductionRepository } from "./helpers/fake-repository";

let dir: string;
let db: SVHDatabase;
let dbService: ProductionService;
let fakeService: ProductionService;
let dbProjectId: string;
let fakeProjectId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-asset-update-"));
  db = createDatabase(join(dir, "test.db"));
  const userId = randomId("usr");
  db.insert(users)
    .values({
      id: userId,
      username: "asset-user",
      email: "asset-user@test.local",
      passwordHash: "x",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const workspaceId = randomId("ws");
  db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "ws-asset",
      rootPath: join(dir, workspaceId),
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  dbService = new ProductionService(new DrizzleProductionRepository(db));
  const fake = new FakeProductionRepository();
  fake.seedOwner(workspaceId, userId);
  fakeService = new ProductionService(fake);

  dbProjectId = (await dbService.createProject({ workspaceId, name: "真库项目" })).id;
  fakeProjectId = (await fakeService.createProject({ workspaceId, name: "假库项目" })).id;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 两条实现共用同一断言集：真库走 Task 2 交付路径，假库守住 server 测试基础设施 */
async function assertNarrowUpdateSemantics(service: ProductionService, projectId: string, tag: string): Promise<void> {
  const created = await service.createAsset({
    projectId,
    type: "video",
    name: "生成视频",
    url: "https://cdn.example.com/remote.mp4",
    mimeType: "video/mp4",
    metadata: { origin: "provider" },
  });

  // 1) 窄更新 workspacePath + metadata：读回一致，其余列不动，updatedAt 不回退
  const localized = await service.updateAssetFields(created.id, {
    workspacePath: "media/ast_local.mp4",
    metadata: { origin: "provider", localization: { state: "ready", bytes: 1024, at: "2026-09-07T00:00:00.000Z" } },
  });
  assert.equal(localized.id, created.id, tag);
  assert.equal(localized.workspacePath, "media/ast_local.mp4", tag);
  assert.deepEqual(
    localized.metadata,
    { origin: "provider", localization: { state: "ready", bytes: 1024, at: "2026-09-07T00:00:00.000Z" } },
    tag,
  );
  assert.ok(localized.updatedAt.getTime() >= created.updatedAt.getTime(), tag);
  assert.equal(localized.name, "生成视频", tag);
  assert.equal(localized.url, "https://cdn.example.com/remote.mp4", tag);
  assert.equal(localized.mimeType, "video/mp4", tag);
  assert.equal(localized.generation, undefined, tag);
  const readBack = await service.getAsset(created.id);
  assert.equal(readBack?.workspacePath, "media/ast_local.mp4", tag);
  assert.deepEqual((readBack?.metadata as { localization?: unknown }).localization, {
    state: "ready",
    bytes: 1024,
    at: "2026-09-07T00:00:00.000Z",
  }, tag);

  // 2) 只更新 metadata：workspacePath 保持不变（set 只能带 patch 中出现的键）
  const touched = await service.updateAssetFields(created.id, {
    metadata: { localization: { state: "failed", error: "HTTP 500" } },
  });
  assert.deepEqual(touched.metadata, { localization: { state: "failed", error: "HTTP 500" } }, tag);
  assert.equal(touched.workspacePath, "media/ast_local.mp4", `${tag}：未出现在 patch 的列不得被写`);

  // 3) mimeType 可单独更新
  const retyped = await service.updateAssetFields(created.id, { mimeType: "image/png" });
  assert.equal(retyped.mimeType, "image/png", tag);
  assert.equal(retyped.workspacePath, "media/ast_local.mp4", tag);

  // 4) null 显式清列
  const cleared = await service.updateAssetFields(created.id, {
    workspacePath: null,
    metadata: null,
    mimeType: null,
  });
  assert.equal(cleared.workspacePath, undefined, tag);
  assert.equal(cleared.metadata, undefined, tag);
  assert.equal(cleared.mimeType, undefined, tag);
  assert.equal(cleared.url, "https://cdn.example.com/remote.mp4", `${tag}：清空窄列不得波及 url`);
  assert.equal((await service.getAsset(created.id))?.workspacePath, undefined, tag);

  // 5) patch 无任何键 = 调用方 bug
  await assert.rejects(
    () => service.updateAssetFields(created.id, {}),
    (error: unknown) =>
      error instanceof ProductionError && error.code === "VALIDATION" && /待更新/.test(error.message),
    tag,
  );

  // 6) 逃逸工作区的路径直接判非法（安全边界仍由 validateWorkspacePath 守）
  await assert.rejects(
    () => service.updateAssetFields(created.id, { workspacePath: "../escape.mp4" }),
    (error: unknown) => error instanceof ProductionError && error.code === "VALIDATION",
    tag,
  );

  // 7) 脏值（来自未校验的 JSON 边界）不得写库：metadata / mimeType 各自判非法
  await assert.rejects(
    () => service.updateAssetFields(created.id, { metadata: "not-an-object" as never }),
    (error: unknown) => error instanceof ProductionError && error.code === "VALIDATION",
    `${tag}：metadata 非对象`,
  );
  await assert.rejects(
    () => service.updateAssetFields(created.id, { mimeType: 42 as never }),
    (error: unknown) => error instanceof ProductionError && error.code === "VALIDATION",
    `${tag}：mimeType 非字符串`,
  );
  // 脏值拒绝后原状态必须保持不变（上一步已把 mimeType 清列）
  const untouched = await service.getAsset(created.id);
  assert.equal(untouched?.mimeType, undefined, `${tag}：非法 patch 不得改列`);
  assert.equal(untouched?.workspacePath, undefined, `${tag}：非法 patch 不得改列`);
}

test("updateAssetFields：真 SQLite 库窄更新语义", async () => {
  await assertNarrowUpdateSemantics(dbService, dbProjectId, "drizzle");
});

test("updateAssetFields：内存假仓储窄更新语义一致", async () => {
  await assertNarrowUpdateSemantics(fakeService, fakeProjectId, "fake");
});

test("updateAssetFields：不存在的资产抛与 getAsset 同款 NotFound", async () => {
  for (const [tag, service] of [
    ["drizzle", dbService],
    ["fake", fakeService],
  ] as const) {
    await assert.rejects(
      () => service.updateAssetFields("ast_missing", { workspacePath: "media/x.mp4" }),
      (error: unknown) =>
        error instanceof ProductionError && error.code === "NOT_FOUND" && error.message === "资产 不存在",
      `${tag} 应抛 NOT_FOUND`,
    );
  }
});

test("updateAssetFields：空 patch 的存在性优先于键校验（不存在 id 仍报 NOT_FOUND）", async () => {
  await assert.rejects(
    () => dbService.updateAssetFields("ast_missing", {}),
    (error: unknown) => error instanceof ProductionError && error.code === "NOT_FOUND",
  );
});
