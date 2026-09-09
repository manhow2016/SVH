/**
 * 角色形象方案路由 HTTP 集成测试（Task 6）。
 *
 * 复用 generation 路由测试基建：真实临时库（mkdtemp）+ buildApp + app.inject + 同库 probe
 * 第二连接直查 payload / production_assets（HTTP 视图刻意不暴露这些列）。
 *
 * 覆盖：
 * - POST schemes：count=3 成功（taskIds/batchId/total + DB payload transferMeta seq 1..3）；
 * - count 缺省=3、越界(0/7)→400、跨用户 404、角色不存在 404；
 * - GET schemes：无批次 { batchId:null, schemes:[] }；有批次 → 最新批 + 批内 seq 升序
 *   （他角色方案/普通图不计入；created_at 由 probe SQL 改写保证批次顺序确定可复现）；
 * - PATCH voiceAssetId：同项目 audio → 200 回读一致；image → 400；
 * - DELETE 角色：其方案资产一并清理（跨批），他角色方案不受影响。
 *
 * 全程零外呼：enqueue 只落库，不启 worker，任务永远停在 queued。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  productionAssets,
  productionProjects,
  productionTasks,
  type SVHDatabase,
} from "@svh/database";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
// 同库第二连接：直查任务 payload / 方案资产行（视图不暴露这些列，只能绕过 HTTP 读）
let probe: SVHDatabase;

let tokenA: string; // 配齐图片模型 Key 的正常用户
let tokenB: string; // 越权用户（只用于「跨用户 404」用例）
let projectId: string;
let wsId: string; // 项目属主工作区（probe 直插资产行需要）
let projectUserId: string; // 项目属主用户 id（同上）

let ch1: { id: string }; // 主角色：生成/列表/PATCH 用例
let ch2: { id: string }; // 干扰方案角色（其方案图不应计入 ch1 列表）
let ch3: { id: string }; // 删除清理用例角色

/** 统一走 HTTP 的 inject 小工具（自动带 Bearer；支持 PATCH/DELETE） */
async function call(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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

/** 注册 + 登录，返回登录 token（与 generation 路由测试同款） */
async function register(username: string): Promise<string> {
  const res = await call("POST", "/api/auth/register", {
    body: { username, email: `${username}@scheme.local`, password: "Scheme12345" },
  });
  assert.equal(res.statusCode, 201, `注册 ${username} 应 201（实际 ${res.statusCode}：${res.body}）`);
  const login = await call("POST", "/api/auth/login", {
    body: { identifier: username, password: "Scheme12345" },
  });
  assert.equal(login.statusCode, 200, `登录 ${username} 应 200（实际 ${login.statusCode}：${login.body}）`);
  return (login.json() as { token: string }).token;
}

/** 建工作区 + 生产项目，返回 projectId */
async function createProject(token: string, name: string): Promise<string> {
  const pjRes = await call("POST", "/api/productions", {
    token,
    body: { name },
  });
  assert.equal(pjRes.statusCode, 200, `创建生产项目应 200（实际 ${pjRes.body}）`);
  return (pjRes.json() as { id: string }).id;
}

/** 建角色，返回完整角色 JSON */
async function createCharacter(token: string, name: string, description: string): Promise<{ id: string }> {
  const res = await call("POST", `/api/projects/${projectId}/characters`, {
    token,
    body: { name, description },
  });
  assert.equal(res.statusCode, 200, `创建角色 ${name} 应 200（实际 ${res.body}）`);
  return res.json() as { id: string };
}

/** 方案元数据打标（与 worker/server 契约字面量一致：svhRole/characterId/batchId/seq） */
function schemeMeta(characterId: string, batchId: string, seq: number): Record<string, unknown> {
  return { svhRole: "character_scheme", characterId, batchId, seq };
}

/** probe 直插一条方案 image 资产（无 url 之外的非空约束，metadata 走 JSON 列） */
function insertSchemeAsset(
  assetId: string,
  characterId: string,
  batchId: string,
  seq: number,
  name: string,
): void {
  probe
    .insert(productionAssets)
    .values({
      id: assetId,
      projectId,
      workspaceId: wsId,
      userId: projectUserId,
      type: "image",
      name,
      url: `https://x/${assetId}.png`,
      metadata: schemeMeta(characterId, batchId, seq),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

/** 直接 SQL 改写 created_at：真实库毫秒级时间戳可能平票，显式写入保证「最新批」选取确定可复现 */
function setAssetCreatedAt(assetId: string, ts: number): void {
  probe.$client.prepare("UPDATE production_assets SET created_at = ? WHERE id = ?").run(ts, assetId);
}

/** 项目内某角色的全部方案资产（跨批）：metadata 打标 svhRole=character_scheme 且 characterId 匹配 */
function schemeAssetsOf(characterId: string): Array<{ id: string; metadata: Record<string, unknown> | null }> {
  return probe
    .select()
    .from(productionAssets)
    .where(eq(productionAssets.projectId, projectId))
    .all()
    .filter((a) => {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      return m.svhRole === "character_scheme" && m.characterId === characterId;
    });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-scheme-route-"));
  const databaseUrl = join(dir, "test.db");
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "scheme-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });
  probe = createDatabase(databaseUrl);

  tokenA = await register("scheme-a");
  tokenB = await register("scheme-b");
  projectId = await createProject(tokenA, "角色面板项目");

  // 项目属主信息（probe 直插资产行需要外键齐全）
  const owner = probe
    .select({ workspaceId: productionProjects.workspaceId, userId: productionProjects.userId })
    .from(productionProjects)
    .where(eq(productionProjects.id, projectId))
    .get()!;
  wsId = owner.workspaceId;
  projectUserId = owner.userId;

  ch1 = await createCharacter(tokenA, "林墨", "主角");
  ch2 = await createCharacter(tokenA, "苏棠", "配角");
  ch3 = await createCharacter(tokenA, "删我", "待清理");

  // A 配齐图片供应商 Key（enqueueImage 入队校验需要；默认 image = volcengine Seedream）
  const put = await call("PUT", "/api/settings", {
    token: tokenA,
    body: { providers: { volcengine: { apiKey: "sk-smoke-volc" } } },
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

// ================= 生成（POST schemes） =================

test("schemes 生成：count=3 → 200 { taskIds(3), batchId, total:3 }；DB payload 带 transferMeta", async () => {
  const res = await call("POST", `/api/projects/${projectId}/characters/${ch1.id}/schemes`, {
    token: tokenA,
    body: { count: 3 },
  });
  assert.equal(res.statusCode, 200, `生成应 200（实际 ${res.statusCode}：${res.body}）`);
  const body = res.json() as { taskIds: string[]; batchId: string; total: number };
  assert.equal(body.taskIds.length, 3);
  assert.ok(body.batchId, "batchId 必须返回");
  assert.equal(body.total, 3);

  // probe 直读三条任务：transferMeta.svhRole/characterId、共享 batchId、seq 1..3、prompt 组合公式
  for (const [i, taskId] of body.taskIds.entries()) {
    const row = probe
      .select()
      .from(productionTasks)
      .where(eq(productionTasks.id, taskId))
      .get();
    assert.ok(row, `任务 ${taskId} 应已落库`);
    assert.ok(row.payload, `任务 ${taskId} payload 必填`);
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const meta = payload.transferMeta as Record<string, unknown>;
    assert.equal(meta.svhRole, "character_scheme");
    assert.equal(meta.characterId, ch1.id);
    assert.equal(meta.batchId, body.batchId, "同批任务必须共享 batchId");
    assert.equal(meta.seq, i + 1, `seq 应为 ${i + 1}`);
    assert.equal(payload.prompt, "林墨，主角", "prompt = 角色名，anchor 空回退 description");
    assert.equal(payload.assetName, `林墨 形象方案${i + 1}`);
  }
});

test("schemes 生成：count 缺省=3；越界(0/7)→400；跨用户→404；角色不存在→404", async () => {
  // 缺省 count → 3（默认值契约）
  const def = await call("POST", `/api/projects/${projectId}/characters/${ch1.id}/schemes`, {
    token: tokenA,
    body: {},
  });
  assert.equal(def.statusCode, 200);
  assert.equal((def.json() as { total: number }).total, 3);

  // 越界：0 / 7 → 400 且不落任务行
  for (const count of [0, 7]) {
    const before0 = probe.select().from(productionTasks).all().length;
    const res = await call("POST", `/api/projects/${projectId}/characters/${ch1.id}/schemes`, {
      token: tokenA,
      body: { count },
    });
    assert.equal(res.statusCode, 400, `count=${count} 应 400（实际 ${res.statusCode}：${res.body}）`);
    assert.match((res.json() as { error: { message: string } }).error.message, /1~6/);
    assert.equal(probe.select().from(productionTasks).all().length, before0, "校验失败不得落任务行");
  }

  // 跨用户：B 对 A 的项目 → 404（归属校验隐藏存在性）
  const cross = await call("POST", `/api/projects/${projectId}/characters/${ch1.id}/schemes`, {
    token: tokenB,
    body: { count: 1 },
  });
  assert.equal(cross.statusCode, 404, `跨用户生成应 404（实际 ${cross.statusCode}：${cross.body}）`);

  // 角色不存在（同项目）→ 404
  const ghost = await call("POST", `/api/projects/${projectId}/characters/chr_ghost/schemes`, {
    token: tokenA,
    body: { count: 1 },
  });
  assert.equal(ghost.statusCode, 404, `角色不存在应 404（实际 ${ghost.statusCode}：${ghost.body}）`);
});

// ================= 列表（GET schemes） =================

test("schemes 列表：无批次 → { batchId:null, schemes:[] }", async () => {
  // 生成只落 queued 任务不落资产：未造方案资产前应为空批次
  const res = await call("GET", `/api/projects/${projectId}/characters/${ch1.id}/schemes`, {
    token: tokenA,
  });
  assert.equal(res.statusCode, 200, `列表应 200（实际 ${res.statusCode}：${res.body}）`);
  assert.deepEqual(res.json(), { batchId: null, schemes: [] });
});

test("schemes 列表：有两批 → 只回最新批 + 批内 seq 升序（他角色方案/普通图不计入）", async () => {
  // 批 A（旧）：a1(seq1)/a2(seq2)；批 B（新）：b2(seq2) 先建、b1(seq1) 后建（验证按 seq 而非创建序）
  insertSchemeAsset("sch_a1", ch1.id, "batch_a", 1, "A1");
  insertSchemeAsset("sch_a2", ch1.id, "batch_a", 2, "A2");
  insertSchemeAsset("sch_b2", ch1.id, "batch_b", 2, "B2");
  insertSchemeAsset("sch_b1", ch1.id, "batch_b", 1, "B1");
  // 干扰项：他角色方案图 + 未打标普通图（均不应计入）
  insertSchemeAsset("sch_c1", ch2.id, "batch_x", 1, "C1");
  probe
    .insert(productionAssets)
    .values({
      id: "sch_plain",
      projectId,
      workspaceId: wsId,
      userId: projectUserId,
      type: "image",
      name: "普通图",
      url: "https://x/plain.png",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  // 批 B 的 created_at 固定晚于批 A（显式 SQL 改写，避免真实时间戳平票）
  const base = Date.now();
  setAssetCreatedAt("sch_a1", base);
  setAssetCreatedAt("sch_a2", base);
  setAssetCreatedAt("sch_b1", base + 1000);
  setAssetCreatedAt("sch_b2", base + 1000);

  const res = await call("GET", `/api/projects/${projectId}/characters/${ch1.id}/schemes`, {
    token: tokenA,
  });
  assert.equal(res.statusCode, 200, `列表应 200（实际 ${res.statusCode}：${res.body}）`);
  const body = res.json() as {
    batchId: string | null;
    schemes: Array<{ id: string; metadata: Record<string, unknown> }>;
  };
  assert.equal(body.batchId, "batch_b", "应取 created_at 最大的批 batch_b");
  assert.deepEqual(
    body.schemes.map((s) => s.id),
    ["sch_b1", "sch_b2"],
    "批内按 seq 升序（1 前 2 后），且他角色/普通图不计入",
  );
  for (const s of body.schemes) {
    assert.equal(s.metadata.svhRole, "character_scheme");
    assert.equal(s.metadata.batchId, "batch_b");
  }
});

test("schemes 列表：跨用户 → 404", async () => {
  const res = await call("GET", `/api/projects/${projectId}/characters/${ch1.id}/schemes`, {
    token: tokenB,
  });
  assert.equal(res.statusCode, 404, `跨用户列表应 404（实际 ${res.statusCode}：${res.body}）`);
});

// ================= PATCH voiceAssetId =================

test("PATCH voiceAssetId：同项目 audio → 200 且回读一致；image → 400", async () => {
  const audio = await call("POST", `/api/projects/${projectId}/assets`, {
    token: tokenA,
    body: { type: "audio", name: "小夜音色", url: "https://x/voice.mp3", mimeType: "audio/mpeg" },
  });
  assert.equal(audio.statusCode, 200, `建音频资产应 200（实际 ${audio.body}）`);
  const audioId = (audio.json() as { id: string }).id;

  const patch = await call("PATCH", `/api/characters/${ch1.id}`, {
    token: tokenA,
    body: { voiceAssetId: audioId },
  });
  assert.equal(patch.statusCode, 200, `PATCH voiceAssetId 应 200（实际 ${patch.statusCode}：${patch.body}）`);
  assert.equal((patch.json() as { voiceAssetId?: string }).voiceAssetId, audioId);

  const get = await call("GET", `/api/characters/${ch1.id}`, { token: tokenA });
  assert.equal((get.json() as { voiceAssetId?: string }).voiceAssetId, audioId, "回读应一致");

  // image 资产 → 400（音色必须为同项目 audio）
  const img = await call("POST", `/api/projects/${projectId}/assets`, {
    token: tokenA,
    body: { type: "image", name: "海报", url: "https://x/poster.png" },
  });
  assert.equal(img.statusCode, 200, `建图片资产应 200（实际 ${img.body}）`);
  const imgId = (img.json() as { id: string }).id;
  const bad = await call("PATCH", `/api/characters/${ch1.id}`, {
    token: tokenA,
    body: { voiceAssetId: imgId },
  });
  assert.equal(bad.statusCode, 400, `image 音色应 400（实际 ${bad.statusCode}：${bad.body}）`);
});

// ================= DELETE 清理 =================

test("DELETE 角色：其方案资产一并清理（跨批），他角色方案不受影响", async () => {
  // ch3 两批方案 + 一个普通资产（应保留：只有打标方案清理）
  insertSchemeAsset("sch_d1", ch3.id, "batch_a", 1, "D1");
  insertSchemeAsset("sch_d2", ch3.id, "batch_b", 1, "D2");
  probe
    .insert(productionAssets)
    .values({
      id: "sch_dplain",
      projectId,
      workspaceId: wsId,
      userId: projectUserId,
      type: "image",
      name: "删我的普通图",
      url: "https://x/dplain.png",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  const beforeCh1 = schemeAssetsOf(ch1.id).length;
  assert.equal(beforeCh1, 4, "前置：ch1 已有 4 张方案资产（批 A/B 各 2）");

  const del = await call("DELETE", `/api/characters/${ch3.id}`, { token: tokenA });
  assert.equal(del.statusCode, 200, `删除应 200（实际 ${del.statusCode}：${del.body}）`);

  // 角色已删；ch3 的打标方案跨批全清、普通资产保留；ch1 方案不受影响
  assertNotFound(await call("GET", `/api/characters/${ch3.id}`, { token: tokenA }));
  assert.equal(schemeAssetsOf(ch3.id).length, 0, "ch3 方案资产应全部清理");
  const plain = probe.select().from(productionAssets).where(eq(productionAssets.id, "sch_dplain")).get();
  assert.ok(plain, "未打标的普通资产不受删除影响");
  assert.equal(schemeAssetsOf(ch1.id).length, beforeCh1, "他角色方案资产不受影响");
});

/** 断言 HTTP 404（越权/不存在统一隐藏存在性） */
function assertNotFound(res: { statusCode: number }): void {
  assert.equal(res.statusCode, 404, `应 404（实际 ${res.statusCode}）`);
}
