/**
 * 会话绑定项目路由测试（V0.3）。
 *
 * 规则：会话与生产项目一对一绑定（项目创建时自动绑定），用户不可新建——
 * 无 projectId 一律 400；POST 为幂等「获取或创建」；列表按项目过滤；
 * 跨用户访问项目会话 404。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
let tokenA: string;
let tokenB: string;
let projectId: string;

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-ses-r-"));
  const config: AppConfig = {
    port: 0,
    databaseUrl: join(dir, "test.db"),
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "session-binding-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });

  const register = async (username: string): Promise<string> => {
    const reg = await call("POST", "/api/auth/register", {
      body: { username, email: `${username}@ses.local`, password: "Ses12345" },
    });
    assert.equal(reg.statusCode, 201, `注册 ${username} 应 201（实际 ${reg.body}）`);
    const login = await call("POST", "/api/auth/login", {
      body: { identifier: username, password: "Ses12345" },
    });
    assert.equal(login.statusCode, 200);
    return (login.json() as { token: string }).token;
  };
  tokenA = await register("ses-a");
  tokenB = await register("ses-b");

  // A 创建项目（应自动绑定会话）
  const pj = await call("POST", "/api/productions", {
    token: tokenA,
    body: { name: "绑定项目" },
  });
  assert.equal(pj.statusCode, 200, `创建项目应 200（实际 ${pj.body}）`);
  projectId = (pj.json() as { id: string }).id;
});

after(async () => {
  try {
    if (app) await app.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("项目创建即绑定会话：列表返回 1 条，标题=项目名", async () => {
  const res = await call("GET", `/api/sessions?projectId=${projectId}`, { token: tokenA });
  assert.equal(res.statusCode, 200, `应 200（实际 ${res.body}）`);
  const sessions = res.json() as Array<{ id: string; projectId: string; title: string }>;
  assert.equal(sessions.length, 1, "项目应恰有一个绑定会话");
  assert.equal(sessions[0]!.projectId, projectId);
  assert.equal(sessions[0]!.title, "绑定项目");
});

test("不允许新建：POST 无 projectId → 400", async () => {
  const res = await call("POST", "/api/sessions", { token: tokenA, body: { title: "x" } });
  assert.equal(res.statusCode, 400, `应 400（实际 ${res.statusCode}：${res.body}）`);
});

test("不允许新建：GET 无 projectId → 400", async () => {
  const res = await call("GET", "/api/sessions", { token: tokenA });
  assert.equal(res.statusCode, 400, `应 400（实际 ${res.statusCode}：${res.body}）`);
});

test("幂等：重复 POST 同一项目不产生新会话", async () => {
  const before1 = await call("GET", `/api/sessions?projectId=${projectId}`, { token: tokenA });
  assert.equal(before1.statusCode, 200);
  const existingId = (before1.json() as Array<{ id: string }>)[0]!.id;

  const res = await call("POST", "/api/sessions", { token: tokenA, body: { projectId } });
  assert.equal(res.statusCode, 201, `应 201（实际 ${res.body}）`);
  assert.equal((res.json() as { id: string }).id, existingId, "应返回既有会话而非新建");

  const after1 = await call("GET", `/api/sessions?projectId=${projectId}`, { token: tokenA });
  assert.equal((after1.json() as unknown[]).length, 1, "会话数不变");
});

test("越权：B 访问 A 的项目会话 → 404（不泄露存在性）", async () => {
  const res = await call("GET", `/api/sessions?projectId=${projectId}`, { token: tokenB });
  assert.equal(res.statusCode, 404, `应 404（实际 ${res.statusCode}：${res.body}）`);
});
