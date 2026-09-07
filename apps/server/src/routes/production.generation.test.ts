/**
 * 生成路由 HTTP 冒烟测试（worker 队列化收尾：routes 层首例 app.inject 集成测试）。
 *
 * 只钉「生成契约面」——路由 ⇄ service ⇄ DB 的边界，不做全站覆盖：
 * - 入队校验的即时反馈（空输入 / 未配 API Key → 400，不落 queued 行）；
 * - 响应形状统一为 `{ task }`（image 与 video 同形，V0.3 前的破坏性收敛）；
 * - 任务视图白名单（10 字段齐，payload/claimedBy/heartbeatAt 不外泄）；
 * - 跨用户越权一律 404（隐藏存在性）；
 * - cancel 的终态语义（queued → cancelled 200；再取消 409；不存在 404）。
 *
 * 全程零外呼：enqueue 只落库，本测试不启 worker，任务永远停在 queued。
 * 真实临时库（mkdtemp + 手工 AppConfig），与在跑的 3456 端口进程互不干扰。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDatabase, productionTasks, type SVHDatabase } from "@svh/database";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
let probe: SVHDatabase; // 只读旁路句柄：直查 payload（视图刻意不暴露，只能绕过 HTTP 验）

let tokenA: string; // 配齐 image + video 模型 Key 的正常用户
let tokenB: string; // 什么都不配置的裸用户（空 Key 分支可达）
let projectId: string; // A 的生产项目
let projectIdB: string; // B 自己的生产项目（只用于「未配 Key」用例：越权会先 404）

/** 任务视图白名单（与 toTaskView 对齐；字段增删必须显式改这里） */
const TASK_VIEW_FIELDS = [
  "id",
  "projectId",
  "kind",
  "status",
  "progress",
  "outputUrl",
  "error",
  "providerId",
  "createdAt",
  "updatedAt",
] as const;

/** 内部列黑名单：任何响应体都不得出现 */
const LEAKED_KEYS = ["payload", "claimedBy", "heartbeatAt", "userId", "workflowId", "nodeId", "providerTaskId"];

/** 统一走 HTTP 的 inject 小工具（自动带 Bearer） */
async function call(
  method: "GET" | "POST" | "PUT",
  url: string,
  opts: { token?: string; body?: unknown } = {},
) {
  return app.inject({
    method,
    url,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : undefined,
    payload: opts.body as never,
  });
}

/** 注册并返回 token（真实密码规则：≥8 位且含字母与数字） */
async function register(username: string): Promise<string> {
  const res = await call("POST", "/api/auth/register", {
    body: { username, email: `${username}@smoke.local`, password: "Smoke12345" },
  });
  assert.equal(res.statusCode, 201, `注册 ${username} 应 201（实际 ${res.statusCode}：${res.body}）`);
  return (res.json() as { token: string }).token;
}

/** 建工作区 + 生产项目，返回 projectId */
async function createProject(token: string, name: string): Promise<string> {
  const wsRes = await call("POST", "/api/workspaces", { token, body: { name: `${name}-ws` } });
  assert.equal(wsRes.statusCode, 201, `创建工作区应 201（实际 ${wsRes.body}）`);
  const workspaceId = (wsRes.json() as { id: string }).id;
  const pjRes = await call("POST", "/api/productions", {
    token,
    body: { workspaceId, name },
  });
  assert.equal(pjRes.statusCode, 200, `创建生产项目应 200（实际 ${pjRes.body}）`);
  return (pjRes.json() as { id: string }).id;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-gen-route-"));
  const databaseUrl = join(dir, "test.db");
  // 手工构造 AppConfig：databaseUrl / workspaceRoot / assetsRoot 全部落临时目录，
  // llm 三件套留空——否则用户级空 Key 会被 env 兜底救活，「未配置 API Key」分支不可达。
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

  tokenA = await register("smoke-a");
  tokenB = await register("smoke-b");
  projectId = await createProject(tokenA, "冒烟项目");
  projectIdB = await createProject(tokenB, "裸账号项目");

  // A 配齐双供应商 Key（默认 image = volcengine Seedream，默认 video = volcengine Seedance）
  const put = await call("PUT", "/api/settings", {
    token: tokenA,
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
  probe?.$client.close();
  if (app) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ================= 入队校验（即时 400 反馈） =================

test("generate-image：空 prompt → 400", async () => {
  const res = await call("POST", `/api/projects/${projectId}/assets/generate-image`, {
    token: tokenA,
    body: { prompt: "   " },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: { message: string } }).error.message, /prompt/);
});

test("generate-image：未配置 API Key 的用户 → 400 且文案指向 Settings", async () => {
  // 用 B 自己的项目：越权会先被归属校验拦成 404，打不到空 Key 分支
  const res = await call("POST", `/api/projects/${projectIdB}/assets/generate-image`, {
    token: tokenB,
    body: { prompt: "有效描述但没有 Key" },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: { message: string } }).error.message, /未配置 API Key/);
});

// ================= 成功入队与响应形状 =================

test("generate-image：成功 → 200 { task }，queued 且不外泄 payload；DB 行 payload 完整", async () => {
  const res = await call("POST", `/api/projects/${projectId}/assets/generate-image`, {
    token: tokenA,
    body: { prompt: "雨夜的霓虹街头", size: "1024x1024" },
  });
  assert.equal(res.statusCode, 200, `入队应 200（实际 ${res.body}）`);
  const body = res.json() as { task?: Record<string, unknown> };
  assert.ok(body.task, "响应必须是 { task } 包装");
  assert.equal(body.task!.status, "queued");
  assert.equal(body.task!.kind, "image");
  for (const key of LEAKED_KEYS) {
    assert.ok(!(key in body.task!), `响应不得含内部字段 ${key}`);
  }

  // payload 是 worker 的执行参数（含明文 Key），只允许落库：绕过 HTTP 直读确认非空
  const row = probe
    .select()
    .from(productionTasks)
    .where(eq(productionTasks.id, body.task!.id as string))
    .get();
  assert.ok(row, "任务行应已落库");
  assert.ok(row.payload && row.payload.length > 0, "DB 中 payload 必须完整写入");
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  assert.equal(payload.prompt, "雨夜的霓虹街头");
  assert.equal(payload.providerId, "volcengine");
  assert.equal(payload.apiKey, "sk-smoke-volc");
});

test("generate-video：成功 → 200，响应与 image 同形（{ task } 包装）", async () => {
  const res = await call("POST", `/api/projects/${projectId}/assets/generate-video`, {
    token: tokenA,
    body: { prompt: "雨夜街头奔跑的武侠", duration: 5 },
  });
  assert.equal(res.statusCode, 200, `入队应 200（实际 ${res.body}）`);
  const body = res.json() as Record<string, unknown>;
  // 破坏性收敛点：video 曾直接返回 task view 本体，现与 image 一致为 { task }
  assert.ok(body.task, "video 响应必须是 { task } 包装（与 image 同形）");
  const task = body.task as Record<string, unknown>;
  assert.equal(task.kind, "video");
  assert.equal(task.status, "queued");
  assert.ok(typeof task.id === "string" && task.id.startsWith("ptk_"));
  for (const key of LEAKED_KEYS) {
    assert.ok(!(key in task), `响应不得含内部字段 ${key}`);
  }
});

test("generate-video：prompt 与 imageUrl 均缺 → 400", async () => {
  const res = await call("POST", `/api/projects/${projectId}/assets/generate-video`, {
    token: tokenA,
    body: { duration: 5 },
  });
  assert.equal(res.statusCode, 400);
  assert.match(
    (res.json() as { error: { message: string } }).error.message,
    /prompt 或 imageUrl 至少提供一个/,
  );
});

// ================= 任务查询 / 越权 =================

test("GET /api/tasks/:id：本人 → 200 且视图字段恰为白名单 10 项", async () => {
  const enq = await call("POST", `/api/projects/${projectId}/assets/generate-image`, {
    token: tokenA,
    body: { prompt: "待查询任务" },
  });
  const taskId = (enq.json() as { task: { id: string } }).task.id;
  const res = await call("GET", `/api/tasks/${taskId}`, { token: tokenA });
  assert.equal(res.statusCode, 200, `查询应 200（实际 ${res.body}）`);
  const view = res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(view).sort(), [...TASK_VIEW_FIELDS].sort(), "视图字段应与 toTaskView 严格一致");
  assert.equal(view.status, "queued");
  assert.equal(view.providerId, "volcengine");
});

test("GET /api/tasks/:id：他人任务 → 404（归属校验隐藏存在性）", async () => {
  const enq = await call("POST", `/api/projects/${projectId}/assets/generate-image`, {
    token: tokenA,
    body: { prompt: "越权读取任务" },
  });
  const taskId = (enq.json() as { task: { id: string } }).task.id;
  const res = await call("GET", `/api/tasks/${taskId}`, { token: tokenB });
  assert.equal(res.statusCode, 404, `跨用户读取应 404（实际 ${res.statusCode}：${res.body}）`);
});

// ================= 取消 =================

test("cancel：queued → 200 cancelled；再 cancel → 409；不存在 → 404", async () => {
  const enq = await call("POST", `/api/projects/${projectId}/assets/generate-image`, {
    token: tokenA,
    body: { prompt: "待取消任务" },
  });
  const taskId = (enq.json() as { task: { id: string } }).task.id;

  const first = await call("POST", `/api/tasks/${taskId}/cancel`, { token: tokenA });
  assert.equal(first.statusCode, 200, `首次取消应 200（实际 ${first.body}）`);
  assert.equal((first.json() as { status: string }).status, "cancelled");

  const second = await call("POST", `/api/tasks/${taskId}/cancel`, { token: tokenA });
  assert.equal(second.statusCode, 409, `重复取消应 409（实际 ${second.body}）`);

  const ghost = await call("POST", "/api/tasks/ptk-not-exists/cancel", { token: tokenA });
  assert.equal(ghost.statusCode, 404, "取消不存在任务应 404");
});

// ================= 项目越权 =================

test("B 对 A 的项目 generate-image → 404（assertProjectOwned 隐藏存在性）", async () => {
  const res = await call("POST", `/api/projects/${projectId}/assets/generate-image`, {
    token: tokenB,
    body: { prompt: "别人的项目" },
  });
  assert.equal(res.statusCode, 404, `跨用户写入应 404（实际 ${res.statusCode}：${res.body}）`);
  // 越权请求不得产生任务行
  const rows = probe
    .select()
    .from(productionTasks)
    .where(and(eq(productionTasks.projectId, projectId), eq(productionTasks.kind, "image")))
    .all();
  assert.ok(rows.length > 0, "前面用例已产生的合法任务应存在（对照组）");
});
