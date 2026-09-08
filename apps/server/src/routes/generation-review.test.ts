/**
 * 生成审核 / 版本路由测试（V0.3 Phase 5）。
 *
 * 冒烟钉契约面：创建/列表生成记录、approve/reject（审核状态迁移）。
 * approve 前的「已完成 + 产出资产」前置通过 probe 直改 generation_records 行，
 * 避免依赖 worker 真实生成（本测试不启 worker）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createDatabase, generationRecords, type SVHDatabase } from "@svh/database";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
let probe: SVHDatabase;
let token: string;
let projectId: string;

async function call(method: "GET" | "POST", url: string, opts: { body?: InjectOptions["payload"] } = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: opts.body });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-review-route-"));
  const databaseUrl = join(dir, "test.db");
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "review-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });
  probe = createDatabase(databaseUrl);

  const reg = await call("POST", "/api/auth/register", {
    body: { username: "review-user", email: "review@smoke.local", password: "Smoke12345" },
  });
  assert.equal(reg.statusCode, 201);
  const login = await call("POST", "/api/auth/login", {
    body: { identifier: "review-user", password: "Smoke12345" },
  });
  token = (login.json() as { token: string }).token;

  const wsRes = await call("POST", "/api/workspaces", { body: { name: "review-ws" } });
  const workspaceId = (wsRes.json() as { id: string }).id;
  const pjRes = await call("POST", "/api/productions", { body: { workspaceId, name: "审核项目" } });
  projectId = (pjRes.json() as { id: string }).id;
});

after(async () => {
  try {
    probe?.$client.close();
    if (app) await app.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("创建生成记录 + 按项目列出", async () => {
  const res = await call("POST", `/api/projects/${projectId}/generations`, {
    body: { kind: "image", prompt: "测试画面" },
  });
  assert.equal(res.statusCode, 200, `创建生成记录应 200（实际 ${res.statusCode}：${res.body}）`);
  const record = res.json() as { id: string; version: number; reviewStatus: string };
  assert.equal(record.version, 1);
  assert.equal(record.reviewStatus, "pending");

  const list = await call("GET", `/api/projects/${projectId}/generations`);
  const items = list.json() as Array<{ id: string }>;
  assert.ok(items.some((r) => r.id === record.id));
});

test("approve：需先置为已完成 + 产出资产；approve 后 reviewStatus=approved, selected=true", async () => {
  // 重新创建一个未完成的记录
  const res = await call("POST", `/api/projects/${projectId}/generations`, {
    body: { kind: "image", prompt: "待审核画面" },
  });
  const record = res.json() as { id: string };

  // 未完成 → 409
  const beforeApprove = await call("POST", `/api/generations/${record.id}/approve`);
  assert.equal(beforeApprove.statusCode, 409, "未完成的生成不可通过审核");

  // probe 直改成已完成 + 产出资产（模拟 worker 完成）
  probe
    .update(generationRecords)
    .set({ status: "completed", outputAssetId: "ast_mock_1" })
    .where(eq(generationRecords.id, record.id))
    .run();

  const approve = await call("POST", `/api/generations/${record.id}/approve`);
  assert.equal(approve.statusCode, 200);
  const after = approve.json() as { reviewStatus: string; selected: boolean };
  assert.equal(after.reviewStatus, "approved");
  assert.equal(after.selected, true);
});

test("reject：标记 rejected，保留记录", async () => {
  const res = await call("POST", `/api/projects/${projectId}/generations`, {
    body: { kind: "image", prompt: "被拒画面" },
  });
  const record = res.json() as { id: string };
  probe
    .update(generationRecords)
    .set({ status: "completed", outputAssetId: "ast_rej" })
    .where(eq(generationRecords.id, record.id))
    .run();

  const reject = await call("POST", `/api/generations/${record.id}/reject`);
  assert.equal(reject.statusCode, 200);
  const after = reject.json() as { reviewStatus: string; selected: boolean };
  assert.equal(after.reviewStatus, "rejected");
  assert.equal(after.selected, false);
});
