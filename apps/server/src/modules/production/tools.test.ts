/**
 * Production Tools 集成测试（文档 §10：Agent 可通过工具操作生产域）。
 *
 * 真实 SQLite 临时库 + ProductionService + 工具工厂，
 * 直接调用每个工具的 execute（模拟 Agent Loop 的工具执行路径）。
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
import {
  createProjectTool,
  getProjectTool,
  updateProjectTool,
  listProjectsTool,
  createScriptTool,
  createCharacterTool,
  createSceneTool,
  createStoryboardTool,
  createShotTool,
  updateShotTool,
} from "@svh/tools";
import type { ToolContext } from "@svh/tools";

let dir: string;
let db: SVHDatabase;
let production: ProductionService;
let ctx: ToolContext;
let projectId: string;

/** 从工具返回值中取出 output */
function out(result: { output: unknown }): Record<string, unknown> {
  return result.output as Record<string, unknown>;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-production-tools-"));
  db = createDatabase(join(dir, "test.db"));
  const userId = randomId("usr");
  db.insert(users)
    .values({
      id: userId,
      username: "tools-user",
      email: "tools-user@test.local",
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
      name: "ws",
      rootPath: join(dir, wsId),
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  ctx = { workspaceId: wsId, sessionId: randomId("ses"), workspaceRoot: join(dir, wsId) };
  production = new ProductionService(new DrizzleProductionRepository(db));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("完整链路：create_project → script/character/scene/storyboard/shot 全链路可执行", async () => {
  const createProject = createProjectTool({ production });
  const result = await createProject.execute(
    { name: "国风短剧", type: "short_drama", duration: 120, style: "chinese_fantasy" },
    ctx,
  );
  const project = out(result);
  projectId = project.id as string;
  assert.equal(project.status, "draft");
  assert.equal(project.workspaceId, ctx.workspaceId);

  // 剧本
  const script = out(await createScriptTool({ production }).execute(
    { projectId, title: "第一集", content: "雨夜，女主登场。" },
    ctx,
  ));
  assert.equal(script.version, 1);

  // 角色
  const character = out(await createCharacterTool({ production }).execute(
    { projectId, name: "女主", description: "冷面猎魔人", appearance: { age: "20", style: "国风" } },
    ctx,
  ));
  assert.equal(character.name, "女主");
  assert.equal((character.appearance as Record<string, unknown>).age, "20");

  // 场景
  const scene = out(await createSceneTool({ production }).execute(
    { projectId, name: "雨夜街头", description: "霓虹倒映", characters: [character.id] },
    ctx,
  ));
  assert.deepEqual(scene.characters, [character.id]);

  // 分镜
  const storyboard = out(await createStoryboardTool({ production }).execute(
    { projectId, sceneId: scene.id, description: "女主特写", duration: 8, shotType: "close_up" },
    ctx,
  ));
  assert.equal(storyboard.duration, 8);

  // 镜头
  const shot = out(await createShotTool({ production }).execute(
    { projectId, storyboardId: storyboard.id, duration: 5, framing: "close_up" },
    ctx,
  ));
  assert.equal(shot.status, "pending");
  const shotReady = out(await updateShotTool({ production }).execute(
    { shotId: shot.id, status: "generating" },
    ctx,
  ));
  assert.equal(shotReady.status, "generating");
});

test("查询工具：list_projects / get_project / 更新状态", async () => {
  const list = await listProjectsTool({ production }).execute({}, ctx);
  const projects = list.output as Array<Record<string, unknown>>;
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.id, projectId);

  const got = out(await getProjectTool({ production }).execute({ projectId }, ctx));
  assert.equal(got.name, "国风短剧");

  const updated = out(await updateProjectTool({ production }).execute(
    { projectId, status: "planning", description: "更新说明" },
    ctx,
  ));
  assert.equal(updated.status, "planning");
});

test("输入校验：缺必填字段返回 INVALID_INPUT 错误（抛 ToolError）", async () => {
  const createProject = createProjectTool({ production });
  await assert.rejects(
    createProject.execute({}, ctx),
    (err: unknown) => err instanceof Error && err.name === "ToolError",
  );
  const createShot = createShotTool({ production });
  await assert.rejects(
    createShot.execute({ projectId, storyboardId: "x" }, ctx),
    (err: unknown) => err instanceof Error && err.name === "ToolError",
  );
});

test("工作区隔离：跨工作区项目访问报「项目 不存在」（工具层不越权）", async () => {
  // 构造另一个工作区上下文（无生产数据）
  const otherWs = randomId("ws");
  const userRow = db.select().from(users).get();
  db.insert(workspaces)
    .values({
      id: otherWs,
      name: "other-ws",
      rootPath: join(dir, otherWs),
      userId: userRow?.id ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const otherCtx: ToolContext = { ...ctx, workspaceId: otherWs };
  await assert.rejects(
    updateProjectTool({ production }).execute({ projectId, status: "completed" }, otherCtx),
    /不存在/,
  );
  await assert.rejects(
    getProjectTool({ production }).execute({ projectId }, otherCtx),
    /不存在/,
  );
});
