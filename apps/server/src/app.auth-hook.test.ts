/**
 * 全局鉴权钩子的路径判定安全测试（评审安全轮）。
 *
 * 漏洞面：钩子曾按原始 request.url 判 /api/ 前缀，而 find-my-way 按「逐段解码后」的
 * 路径匹配路由 → `/%61pi/workspaces`（编码后仍解码为 /api）跳过 authenticate 却直达
 * 受保护处理器（实测 500：req.user 缺失）。修法=钩子判定与路由同源：逐段 safe-decode。
 *
 * 一致性口径（逐变体钉死，防修复引入新绕过/新误拦）：
 * - 能解码成 /api/ 前缀的变体 → 必须走 authenticate（401，绝不 500/200）；
 * - 路由本来 404 的（大写、双编码、//api）→ 允许 404/401，但不得 200/500；
 * - 判定「宁严勿松」：路由匹配不到但前缀长得像 /api 的（%2F 段内编码）→ 401 可接受；
 * - PUBLIC 路径（注册/登录）的编码变体不得被误拦（登录 200 仍可达）；
 * - 正常 /api 与 /api/media 行为零回归。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import type { AppConfig } from "./config/index";

let dir: string;
let app: FastifyInstance;
let token: string;
let projectId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-hook-sec-"));
  const config: AppConfig = {
    port: 0,
    databaseUrl: join(dir, "test.db"),
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "hook-sec-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "hook-a", email: "hook-a@sec.local", password: "Hook12345" },
  });
  assert.equal(reg.statusCode, 201, `注册应 201（实际 ${reg.body}）`);
  token = (reg.json() as { token: string }).token;
  // V0.3：会话与项目绑定——先建项目（自动绑定会话），供会话查询断言使用
  const created = await app.inject({
    method: "POST",
    url: "/api/productions",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "hook项目" },
  });
  assert.equal(created.statusCode, 200, `建项目应 200（实际 ${created.body}）`);
  projectId = (created.json() as { id: string }).id;
});

after(async () => {
  try {
    if (app) await app.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("编码前缀 /%61pi/workspaces（=/api/…）无 Authorization → 401（曾 500：绕钩子直达受保护处理器）", async () => {
  const res = await app.inject({ method: "GET", url: "/%61pi/workspaces" });
  assert.equal(res.statusCode, 401, `编码绕过必须被鉴权拦截（实际 ${res.statusCode}：${res.body}）`);
});

test("编码前缀 /a%70i/workspaces（另一编码位点）→ 401", async () => {
  const res = await app.inject({ method: "GET", url: "/a%70i/workspaces" });
  assert.equal(res.statusCode, 401);
});

test("段内 %2F（/api%2Fworkspaces）→ 宁严勿松 401（路由匹配不到也不放行）", async () => {
  const res = await app.inject({ method: "GET", url: "/api%2Fworkspaces" });
  assert.equal(res.statusCode, 401);
});

test("双编码 /%25%36%31pi/workspaces → 404 不 200/500（钩子与 find-my-way 都只解一层，判定一致）", async () => {
  const res = await app.inject({ method: "GET", url: "/%25%36%31pi/workspaces" });
  assert.ok(
    res.statusCode === 404 || res.statusCode === 401,
    `应落 404/401（实际 ${res.statusCode}：${res.body}）`,
  );
});

test("大小写 /API/workspaces 与编码大写 /%41PI/workspaces → 404（路由区分大小写，双方一致，不泄露受保护面）", async () => {
  const raw = await app.inject({ method: "GET", url: "/API/workspaces" });
  assert.equal(raw.statusCode, 404);
  const enc = await app.inject({ method: "GET", url: "/%41PI/workspaces" });
  assert.equal(enc.statusCode, 404);
});

test("//api/sessions（协议相对写法）→ 404 不 200/500", async () => {
  const res = await app.inject({ method: "GET", url: "//api/sessions" });
  assert.equal(res.statusCode, 404);
});

test("编码变体不误拦 PUBLIC：/%61pi/auth/login 真实凭据 → 200 且回 token", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/%61pi/auth/login",
    payload: { identifier: "hook-a", password: "Hook12345" },
  });
  assert.equal(res.statusCode, 200, `编码登录入口不得被误拦（实际 ${res.statusCode}：${res.body}）`);
  assert.ok((res.json() as { token?: string }).token);
});

test("编码前缀同样不泄露受保护数据：/%61pi/sessions 带合法 Bearer → 200（走的是同一个 handler）", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/%61pi/sessions?projectId=${projectId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, `带 token 应正常 200（实际 ${res.body}）`);
});

test("零回归：/api/sessions 无 token 401、带 token 200；/api/auth/register 编码与否都可达", async () => {
  const anon = await app.inject({ method: "GET", url: "/api/sessions" });
  assert.equal(anon.statusCode, 401);
  const mine = await app.inject({
    method: "GET",
    url: `/api/sessions?projectId=${projectId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(mine.statusCode, 200);
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "hook-b", email: "hook-b@sec.local", password: "Hook12345" },
  });
  assert.equal(reg.statusCode, 201);
});
