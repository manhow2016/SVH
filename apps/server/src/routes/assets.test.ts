/**
 * 「我的资产」生成路由测试：POST /api/assets/generate。
 *
 * 钉住 V0.3 修复后的契约面（此前硬编码 projectId "default" 导致 404「项目 不存在」）：
 * - 未登录 → 401；
 * - 免费用户 → 403（assets.library 为专业版功能，会员门控）；
 * - 生成任务归属系统资产库项目（「我的资产」，按用户幂等创建，描述哨兵标识）；
 * - 制作中心项目列表（GET /api/productions）隐藏该系统项目；
 * - 资产库生成任务行：task.projectId = 库项目 id，payload.assetLibrary = { folder, type }，
 *   payload 含组合提示词（composedPrompt，V0.3 Phase 2 链路保留）；
 * - 裸用户（未配置图片模型 Key）→ 400 且不落 queued 行（即时反馈语义）。
 *
 * 全程零外呼：enqueue 只落库，不启 worker（任务停在 queued）。
 * 主流程用引导管理员账号（功能门控跳过；管理员具备专业版全部功能位）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createDatabase, productionProjects, productionTasks, type SVHDatabase } from "@svh/database";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";
import { ASSET_LIBRARY_PROJECT_DESC_PREFIX } from "./assets";

let dir: string;
let app: FastifyInstance;
let probe: SVHDatabase;

let tokenAdmin: string; // 引导管理员：跳过功能门控 + 配好图片模型 Key
let tokenFree: string; // 免费裸用户（无会员功能位 → 403）

async function call(
  method: "GET" | "POST" | "PUT",
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

async function login(identifier: string, password: string): Promise<string> {
  const login = await call("POST", "/api/auth/login", {
    body: { identifier, password },
  });
  assert.equal(login.statusCode, 200, `登录 ${identifier} 应 200（实际 ${login.statusCode}：${login.body}）`);
  return (login.json() as { token: string }).token;
}

/** 系统资产库项目行（按描述哨兵过滤；无则空数组） */
function libraryProjects(): Array<{ id: string; name: string; description: string | null }> {
  return probe
    .select({ id: productionProjects.id, name: productionProjects.name, description: productionProjects.description })
    .from(productionProjects)
    .all()
    .filter(p => p.description?.startsWith(ASSET_LIBRARY_PROJECT_DESC_PREFIX) ?? false);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-assets-route-"));
  const databaseUrl = join(dir, "test.db");
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "smoke-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });
  probe = createDatabase(databaseUrl);

  tokenAdmin = await login("admin", "admin123456");
  const reg = await call("POST", "/api/auth/register", {
    body: { username: "free-a", email: "free-a@assets-smoke.local", password: "Smoke12345" },
  });
  assert.equal(reg.statusCode, 201, `注册 free-a 应 201（实际 ${reg.statusCode}：${reg.body}）`);
  tokenFree = await login("free-a", "Smoke12345");

  // 管理员配齐图片供应商 Key（默认 image = volcengine）
  const put = await call("PUT", "/api/settings", {
    token: tokenAdmin,
    body: {
      providers: {
        volcengine: { apiKey: "sk-smoke-volc" },
        dashscope: { apiKey: "sk-smoke-dash" },
      },
    },
  });
  assert.equal(put.statusCode, 200, `写入模型设置应 200（实际 ${put.body}）`);
});

after(async () => {
  try {
    probe?.$client.close();
    if (app) await app.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 契约用例 =================

test("未登录 → 401", async () => {
  const res = await call("POST", "/api/assets/generate", {
    body: { type: "character", name: "小美", description: "测试角色", count: 1 },
  });
  assert.equal(res.statusCode, 401);
});

test("免费用户 → 403（assets.library 会员门控），不落任何行", async () => {
  const before = probe.select({ id: productionTasks.id }).from(productionTasks).all().length;
  const res = await call("POST", "/api/assets/generate", {
    token: tokenFree,
    body: { type: "character", name: "小美", description: "测试角色", count: 1 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: { code: string } }).error.code, "FEATURE_NOT_AVAILABLE");
  assert.equal(
    probe.select({ id: productionTasks.id }).from(productionTasks).all().length,
    before,
    "门控拒绝不得产生任务行",
  );
});

test("生成角色：任务归属系统资产库项目（幂等创建）+ payload.assetLibrary 透传", async () => {
  const beforeLib = libraryProjects().length;

  const res = await call("POST", "/api/assets/generate", {
    token: tokenAdmin,
    body: {
      type: "character",
      name: "小美",
      style: "真人风格",
      description: "古装少女，齐刘海",
      count: 2,
      folder: "默认",
    },
  });
  assert.equal(res.statusCode, 200, `生成应 200（实际 ${res.statusCode}：${res.body}）`);
  const body = res.json() as { taskIds: string[]; total: number };
  assert.equal(body.taskIds.length, 2);
  assert.equal(body.total, 2);

  // 系统资产库项目已创建（此前应不存在 → 数量 +1）
  const libs = libraryProjects();
  assert.equal(libs.length, beforeLib + 1, `应恰好新建 1 个库项目（实际 ${libs.length}）`);
  const libProjectId = libs[0]!.id;
  assert.match(libs[0]!.name, /我的资产/);

  // 任务行：projectId = 库项目；payload.assetLibrary + 组合提示词链路保留
  for (const taskId of body.taskIds) {
    const row = probe
      .select()
      .from(productionTasks)
      .where(eq(productionTasks.id, taskId))
      .get();
    assert.ok(row, `任务 ${taskId} 应落库`);
    assert.equal(row.projectId, libProjectId, "任务必须归属系统资产库项目");
    const payload = JSON.parse(row.payload ?? "{}") as {
      assetLibrary?: { folder: string; type: string };
      composedPrompt?: string;
      prompt?: string;
    };
    assert.deepEqual(payload.assetLibrary, { folder: "默认", type: "character" });
    assert.equal(payload.prompt, "古装少女，齐刘海");
    assert.ok(typeof payload.composedPrompt === "string" && payload.composedPrompt.includes("古装少女"), "应组合提示词");
  }
});

test("幂等：再次生成不新建系统资产库项目", async () => {
  const libsBefore = libraryProjects().length;
  const res = await call("POST", "/api/assets/generate", {
    token: tokenAdmin,
    body: { type: "character", name: "小红", description: "红衣少女", count: 1, folder: "默认" },
  });
  assert.equal(res.statusCode, 200, `再次生成应 200（实际 ${res.body}）`);
  assert.equal(libraryProjects().length, libsBefore, "库项目必须幂等复用，不得重复创建");
});

test("制作中心项目列表隐藏系统资产库项目", async () => {
  const res = await call("GET", "/api/productions", { token: tokenAdmin });
  assert.equal(res.statusCode, 200);
  const projects = res.json() as Array<{ name: string }>;
  assert.ok(
    !projects.some(p => p.name === "我的资产"),
    `项目列表不得出现系统资产库项目（实际：${JSON.stringify(projects.map(p => p.name))}）`,
  );
});

test("folder 含路径分隔符 → 400 且不落 queued 行", async () => {
  const before = probe.select({ id: productionTasks.id }).from(productionTasks).all().length;
  const res = await call("POST", "/api/assets/generate", {
    token: tokenAdmin,
    body: { type: "prop", name: "玉佩", summary: "古玉佩", imageDescription: "青色玉佩", count: 1, folder: "默认/../逃逸" },
  });
  assert.equal(res.statusCode, 400, `非法 folder 应 400（实际 ${res.body}）`);
  assert.equal(
    probe.select({ id: productionTasks.id }).from(productionTasks).all().length,
    before,
    "校验失败不得产生任务行",
  );
});
