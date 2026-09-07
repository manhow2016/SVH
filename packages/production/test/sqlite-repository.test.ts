/**
 * Production 仓储适配层集成测试（真实 SQLite 临时库，文档 §6 / §17）。
 *
 * 与 model-settings.test.ts 同款模式：临时目录 + createDatabase，
 * 验证 drizzle 实现的行↔实体映射、JSON 列往返、工作区隔离、级联删除与事务回滚。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, users, workspaces, productionProjects, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import { DrizzleProductionRepository } from "../src/sqlite-repository";
import { ProductionService } from "../src/index";
import { eq } from "drizzle-orm";

let dir: string;
let db: SVHDatabase;
let repo: DrizzleProductionRepository;
let service: ProductionService;
let userId: string;
let wsA: string;
let wsB: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "svh-production-repo-"));
  db = createDatabase(join(dir, "test.db"));
  userId = randomId("usr");
  db.insert(users)
    .values({
      id: userId,
      username: "prod-user",
      email: "prod-user@test.local",
      passwordHash: "x",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  wsA = randomId("ws");
  wsB = randomId("ws");
  for (const wsId of [wsA, wsB]) {
    db.insert(workspaces)
      .values({
        id: wsId,
        name: `ws-${wsId}`,
        rootPath: join(dir, wsId),
        userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
  }
  repo = new DrizzleProductionRepository(db);
  service = new ProductionService(repo);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("getWorkspaceOwner：存在返回归属，不存在返回 null", async () => {
  assert.deepEqual(await repo.getWorkspaceOwner(wsA), { workspaceId: wsA, userId });
  assert.equal(await repo.getWorkspaceOwner("ws_missing"), null);
});

test("项目 CRUD + JSON 列往返 + 工作区隔离", async () => {
  const project = await service.createProject({
    workspaceId: wsA,
    name: "国风短剧",
    type: "short_drama",
    settings: { duration: 120, style: "chinese_fantasy", generation: { model: "wanx" } },
    description: "测试项目",
  });
  assert.match(project.id, /^prj_/);
  assert.equal(project.userId, userId);
  assert.ok(project.createdAt instanceof Date);
  assert.deepEqual(project.settings, { duration: 120, style: "chinese_fantasy", generation: { model: "wanx" } });

  const other = await service.createProject({ workspaceId: wsB, name: "B 项目" });
  const listA = await service.listProjects(wsA);
  assert.deepEqual(listA.map((p) => p.id), [project.id]);
  const listB = await service.listProjects(wsB);
  assert.deepEqual(listB.map((p) => p.id), [other.id]);

  const updated = await service.updateProject(project.id, { name: "国风短剧 V2", status: "planning" });
  assert.equal(updated.name, "国风短剧 V2");
  assert.equal(updated.status, "planning");
});

test("全链路：剧本→场景→分镜→镜头→资产（含筛选与资产删除）", async () => {
  const project = await service.createProject({ workspaceId: wsA, name: "链路项目" });
  const script = await service.createScript({
    projectId: project.id,
    title: "第一集",
    content: "角色 A 与 B 相遇",
  });
  const script2 = await service.createScript({
    projectId: project.id,
    title: "第二集",
    content: "角色 B 离开",
  });
  assert.equal((await service.listScripts(project.id)).length, 2);

  const scene = await service.createScene({
    projectId: project.id,
    scriptId: script.id,
    name: "场景1 街头",
    description: "雨夜街头",
    characters: ["chr_1", "chr_2"],
  });
  assert.deepEqual(scene.characters, ["chr_1", "chr_2"]);
  const scene2 = await service.createScene({ projectId: project.id, name: "场景2", description: "室内" });
  assert.equal(scene.order, 0);
  assert.equal(scene2.order, 1);

  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "特写",
    duration: 8,
    shotType: "medium_shot",
    imagePrompt: "雨夜霓虹",
  });
  const storyboard2 = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "全景",
    duration: 6,
    shotType: "wide_shot",
  });
  assert.equal(storyboard2.order, 1);
  assert.equal((await service.listStoryboardsByScene(scene.id)).length, 2);

  const shot = await service.createShot({
    projectId: project.id,
    storyboardId: storyboard.id,
    duration: 5,
    framing: "close_up",
  });
  assert.equal(shot.duration, 5);
  await assert.rejects(
    service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 5 }),
    /不能超过/,
  );

  const asset = await service.createAsset({
    projectId: project.id,
    type: "image",
    name: "分镜图",
    url: "https://cdn.example.com/shot.png",
    generation: { providerId: "dashscope", modelId: "wanx", taskId: "t1" },
  });
  assert.equal(asset.workspaceId, wsA);
  assert.equal(asset.userId, userId);
  assert.equal((await service.listAssets(project.id, "image")).length, 1);
  assert.equal((await service.listAssets(project.id, "video")).length, 0);

  await service.deleteAsset(asset.id);
  assert.equal(await repo.getAsset(asset.id), null);

  // 隔离只读校验
  const other = await service.createProject({ workspaceId: wsB, name: "B 项目2" });
  assert.equal((await service.listScripts(other.id)).length, 0);
  assert.ok(script2.id !== script.id, "脚本分属两个版本");
});

test("级联删除：删除项目后其剧本/场景/分镜/资产一并删除", async () => {
  const project = await service.createProject({ workspaceId: wsA, name: "级联项目" });
  const script = await service.createScript({ projectId: project.id, title: "t", content: "c" });
  const scene = await service.createScene({ projectId: project.id, name: "s", description: "d" });
  await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "d",
    duration: 5,
    shotType: "medium",
  });
  await service.createAsset({ projectId: project.id, type: "image", name: "a", url: "https://x.com/a.png" });

  db.delete(productionProjects).where(eq(productionProjects.id, project.id)).run();

  assert.equal(await repo.getProject(project.id), null);
  assert.equal(await repo.getScript(script.id), null);
  assert.equal(await repo.getScene(scene.id), null);
  assert.equal((await service.listAssets(project.id)).length, 0);
});

test("事务：fn 抛错整体回滚，无残留行", async () => {
  const project = await service.createProject({ workspaceId: wsA, name: "事务项目" });
  await assert.rejects(
    repo.transaction(async (txRepo) => {
      await txRepo.createScript({ projectId: project.id, title: "t", content: "c", version: 1, status: "draft" });
      await txRepo.createScript({ projectId: project.id, title: "t2", content: "c2", version: 1, status: "draft" });
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal((await service.listScripts(project.id)).length, 0);
});

test("事务：fn 成功提交", async () => {
  const project = await service.createProject({ workspaceId: wsA, name: "事务提交项目" });
  await repo.transaction(async (txRepo) => {
    await txRepo.createScript({ projectId: project.id, title: "t", content: "c", version: 1, status: "draft" });
  });
  assert.equal((await service.listScripts(project.id)).length, 1);
});
