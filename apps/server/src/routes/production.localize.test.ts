/**
 * 手动重试 API + 删除文件清理冒烟测试（Task 4：POST /api/assets/:assetId/localize、DELETE 清理）。
 *
 * 只钉「手动转存契约面」（spec §6/§8 + Task 2 裁决）：
 * - ready 幂等：谓词同 media（workspacePath && localization.state==="ready"）→ 200 零重下（fetch 计数钉）；
 * - failed→ready：扩展名沿用既有命名、无旧路径按 kind 兜底（image→png）；Content-Type 命中白名单
 *   且 DB mimeType 缺省/不符时兜正 mimeType；bytes 在案；真文件落盘且不留 .part；
 * - 全失败：422 + error 文案，且 DB 状态先收敛（localization.state==="failed" + error 在案）再回话；
 *   重试 4 次退避（注入 sleep 记录 500/2000/8000，生产最坏时长 = 下载 + 退避，见路由注释）；
 * - b64 直出（url null）→ 400 单独文案，绝不落任何 localization 键；
 * - 404 三态同构（复用 Task 3 纪律）：越权与不存在响应体逐字同构，封堵存在性 oracle；
 *   越权绝不走到 url 判空/下载那步；
 * - DELETE 清理：ready 资产删行 + 物理删文件；failed（path null）不炸；ready 但文件丢失 200（吞 ENOENT）；
 *   workspacePath 非 media/ 前缀（用户手放）→ DB 删但文件保留（保守，只清本特性产物）。
 *
 * harness 逐字复用 media.test.ts：手工 AppConfig（workspaceRoot 落 mkdtemp，绝不写真 data/workspaces）
 * + buildApp({logger:false}) + inject + 旁路第二连接直插资产行；
 * 差异点：buildApp 收 localize:{fetchImpl,sleep} 注入面（下载网络与退避的假实现，生产缺省真实值）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDatabase, productionAssets, type SVHDatabase } from "@svh/database";
import { LOCALIZE_METADATA_KEY, type LocalizeMetadata } from "@svh/production";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
// 旁路第二连接：资产行的 failed/ready 预置没有写入 API（真实链路靠 worker），只能直插；
// 同时兼作「响应之外」的 DB 状态回读面（localization 键、workspacePath、mimeType）。
let probe: SVHDatabase;

let tokenA: string; // 资产主人
let userIdA: string;
let tokenB: string; // 越权者
let wsIdA: string; // A 的工作区（转存目录名 = wsId）
let projectIdA: string;

/** 假下载的统一正文：24 字节，与 ready 预置文件的字节刻意不同（幂等用例靠它证「没被覆写」） */
const OK_BYTES = Buffer.from("FAKE-REMOTE-JPEG-PAYLOAD");
/** ready 预置文件内容（幂等后必须原样保留） */
const READY_BYTES = Buffer.from("LOCAL-READY-CONTENT-UNTOUCHED");

/** fetch 调用记录（URL 串）：各用例按 assetId 子串计数，钉「该下的下了几次 / 不该下的零次」 */
let fetchCalls: string[] = [];
/** sleep 注入记录（真实毫秒值，注入实现不等待）：钉退避序列 500/2000/8000 */
let sleepCalls: number[] = [];

/** 假网络：url 含 /never → 抛错（不可达）；其余 → 200 + image/jpeg（DB 侧刻意预置 png 验兜正） */
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  fetchCalls.push(url);
  if (url.includes("/never")) {
    throw new Error("connect ECONNREFUSED remote.example");
  }
  return new Response(Buffer.from(OK_BYTES), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
};

const fakeSleep = async (ms: number): Promise<void> => {
  sleepCalls.push(ms);
};

/** POST localize（auth 走标准 Bearer，与非 production 豁免面同钩子路径） */
async function localize(assetId: string, token: string) {
  return app.inject({
    method: "POST",
    url: `/api/assets/${assetId}/localize`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 真文件落 <workspaceRoot>/<wsId>/<rel>（与 worker 转存目录同形） */
function writeMedia(rel: string, content: Buffer): void {
  const abs = join(dir, "workspaces", wsIdA, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** 预置一行资产（列名 snake_case；三级 FK 全真，同 media.test.ts 形状） */
async function seedAsset(input: {
  id: string;
  url: string | null;
  workspacePath: string | null;
  mimeType: string | null;
  localization: LocalizeMetadata | null;
}): Promise<void> {
  const now = new Date();
  await probe.insert(productionAssets).values({
    id: input.id,
    projectId: projectIdA,
    workspaceId: wsIdA,
    userId: userIdA,
    type: "image",
    name: input.id,
    url: input.url,
    workspacePath: input.workspacePath,
    mimeType: input.mimeType,
    metadata: input.localization
      ? ({ [LOCALIZE_METADATA_KEY]: input.localization } as Record<string, unknown>)
      : null,
    createdAt: now,
    updatedAt: now,
  });
}

/** DB 回读（绕过 HTTP 钉列值） */
function readRow(id: string) {
  return probe.select().from(productionAssets).where(eq(productionAssets.id, id)).get();
}

/** 回读 metadata 里的 localization 键（JSON 列由 drizzle 解析成对象） */
function readLocalization(id: string): LocalizeMetadata | undefined {
  const row = readRow(id);
  const meta = row?.metadata as Record<string, unknown> | null | undefined;
  return meta?.[LOCALIZE_METADATA_KEY] as LocalizeMetadata | undefined;
}

const READY = (): LocalizeMetadata => ({ state: "ready", bytes: 1, at: "2026-09-07T00:00:00.000Z" });
const FAILED = (error: string): LocalizeMetadata => ({
  state: "failed",
  error,
  at: "2026-09-07T00:00:00.000Z",
});

/** 注册 + 登录（密码规则 ≥8 位含字母数字），返回 token 与 userId */
async function register(username: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, email: `${username}@localize.local`, password: "Localize12345" },
  });
  assert.equal(res.statusCode, 201, `注册 ${username} 应 201（实际 ${res.statusCode}：${res.body}）`);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { identifier: username, password: "Localize12345" },
  });
  assert.equal(login.statusCode, 200, `登录 ${username} 应 200（实际 ${login.statusCode}：${login.body}）`);
  const body = login.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

/** 建工作区 + 生产项目（三级 FK 经真 API 创建，与 media.test.ts 同形） */
async function createProject(token: string, name: string): Promise<{ wsId: string; projectId: string }> {
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: `${name}-ws` },
  });
  assert.equal(wsRes.statusCode, 201, `创建工作区应 201（实际 ${wsRes.body}）`);
  const wsId = (wsRes.json() as { id: string }).id;
  const pjRes = await app.inject({
    method: "POST",
    url: "/api/productions",
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: wsId, name },
  });
  assert.equal(pjRes.statusCode, 200, `创建生产项目应 200（实际 ${pjRes.body}）`);
  return { wsId, projectId: (pjRes.json() as { id: string }).id };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-localize-route-"));
  const databaseUrl = join(dir, "test.db");
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "localize-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false, localize: { fetchImpl: fakeFetch, sleep: fakeSleep } });
  probe = createDatabase(databaseUrl);

  const a = await register("localize-a");
  tokenA = a.token;
  userIdA = a.userId;
  tokenB = (await register("localize-b")).token;
  const proj = await createProject(tokenA, "转存项目");
  wsIdA = proj.wsId;
  projectIdA = proj.projectId;

  // ---- localize 用例家族（一行一语义，互不干扰） ----
  // ready：文件真在盘，字节与假下载正文刻意不同 → 幂等用例可证「没被覆写」
  writeMedia("media/ast_ready.png", READY_BYTES);
  await seedAsset({
    id: "ast_ready",
    url: "https://remote.example/ok/ast_ready",
    workspacePath: "media/ast_ready.png",
    mimeType: "image/png",
    localization: READY(),
  });
  // failed（Task 2 契约：failed 行 path 恒 null）→ 重试成功，扩展名按 kind 兜 png，mime 兜正 jpeg
  await seedAsset({
    id: "ast_failed_retry",
    url: "https://remote.example/ok/ast_failed_retry",
    workspacePath: null,
    mimeType: "image/png", // 与假下载的 image/jpeg 不符 → 必须兜正
    localization: FAILED("上次网络炸"),
  });
  // 无键远程资产，url 指向 /never → 4 次全失败 → 422 + failed 落库
  await seedAsset({
    id: "ast_dead",
    url: "https://remote.example/never/ast_dead",
    workspacePath: null,
    mimeType: "image/png",
    localization: null,
  });
  // b64 直出（url null）→ 400 且零落键
  await seedAsset({
    id: "ast_b64",
    url: null,
    workspacePath: null,
    mimeType: "image/png",
    localization: null,
  });
  // 他人（对 B）视角的 b64 资产：T4 Important-1 直钉——归属校验必须在 url 判空之前，
  // 否则越权者能靠 400/404 差值探出「该行无远程地址」（变异验证：判空前移 → 本家族用例必红）
  await seedAsset({
    id: "ast_foreign_b64",
    url: null,
    workspacePath: null,
    mimeType: "image/png",
    localization: null,
  });
  // A 的资产专供 B 越权 404（不被任何本主用例改写）
  await seedAsset({
    id: "ast_foreign",
    url: "https://remote.example/ok/ast_foreign",
    workspacePath: null,
    mimeType: "image/png",
    localization: FAILED("占位"),
  });
  // 旧命名沿用：media/legacy.jpg（无 localization 键的远程模式）→ 重试后扩展名保持 jpg
  await seedAsset({
    id: "ast_legacy",
    url: "https://remote.example/ok/ast_legacy",
    workspacePath: "media/legacy.jpg",
    mimeType: "image/jpeg", // 与假下载一致 → 不得覆写（此处应零改动）
    localization: null,
  });
  // ready 但磁盘文件丢失（media 路由 410 形态）→ 手动重试短路必须失效并自愈重下（终审 I1）
  await seedAsset({
    id: "ast_selfheal",
    url: "https://remote.example/ok/ast_selfheal",
    workspacePath: "media/ast_selfheal.png",
    mimeType: "image/png",
    localization: READY(),
  });

  // ---- DELETE 清理用例家族 ----
  writeMedia("media/ast_del_ready.png", READY_BYTES);
  await seedAsset({
    id: "ast_del_ready",
    url: "https://remote.example/ok/ast_del_ready",
    workspacePath: "media/ast_del_ready.png",
    mimeType: "image/png",
    localization: READY(),
  });
  await seedAsset({
    id: "ast_del_failed",
    url: "https://remote.example/ok/ast_del_failed",
    workspacePath: null, // failed 行 path 恒 null → 删除不得炸
    mimeType: "image/png",
    localization: FAILED("无本地文件"),
  });
  // ready 但盘上没有（模拟误删）→ unlink ENOENT 必须吞掉，仍 200
  await seedAsset({
    id: "ast_del_gone",
    url: "https://remote.example/ok/ast_del_gone",
    workspacePath: "media/ast_del_gone.png",
    mimeType: "image/png",
    localization: READY(),
  });
  // 用户手放路径（非 media/ 前缀）→ 只删行，文件保留
  writeMedia("notes/manual.png", READY_BYTES);
  await seedAsset({
    id: "ast_del_manual",
    url: "https://remote.example/ok/ast_del_manual",
    workspacePath: "notes/manual.png",
    mimeType: "image/png",
    localization: READY(),
  });
});

after(async () => {
  try {
    probe?.$client.close();
    if (app) await app.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 手动重试 =================

test("ready 资产幂等：200 {asset} 且零重下（fetch 计数 0、磁盘字节未被覆写）", async () => {
  fetchCalls = [];
  const res = await localize("ast_ready", tokenA);
  assert.equal(res.statusCode, 200, `应 200（实际 ${res.statusCode}：${res.body}）`);
  const body = res.json() as { asset?: { id: string; workspacePath?: string } };
  assert.equal(body.asset?.id, "ast_ready");
  assert.equal(body.asset?.workspacePath, "media/ast_ready.png");
  assert.equal(fetchCalls.length, 0, "ready 短路不得发起任何下载");
  const onDisk = readBytesIf(join(dir, "workspaces", wsIdA, "media/ast_ready.png"));
  assert.ok(onDisk?.equals(READY_BYTES), "幂等返回不得重下，原文件字节必须原样");
});

test("ready 但文件丢失 → 短路补 stat 失效，落入重下载路径自愈（200、落盘、ready 刷新）", async () => {
  fetchCalls = [];
  const abs = join(dir, "workspaces", wsIdA, "media/ast_selfheal.png");
  assert.ok(!existsSync(abs), "前置：磁盘无文件（ready 悬空态）");
  const res = await localize("ast_selfheal", tokenA);
  assert.equal(res.statusCode, 200, `ready 悬空必须自愈重下而非空 200（实际 ${res.statusCode}：${res.body}）`);
  assert.equal(fetchCalls.length, 1, "短路失效 → 恰一次重下载");
  assert.ok(readBytesIf(abs)?.equals(OK_BYTES), "自愈后文件真实落盘");
  const loc = readLocalization("ast_selfheal");
  assert.equal(loc?.state, "ready");
  assert.equal(loc?.bytes, OK_BYTES.length, "ready 记录刷新为本次字节");
  assert.equal(readRow("ast_selfheal")?.workspacePath, "media/ast_selfheal.png", "扩展名沿用旧命名");
});

test("failed→ready：kind 兜底扩展名 .png、mime 兜正 image/jpeg、bytes 在案；真文件落盘无 part 残留", async () => {
  fetchCalls = [];
  const res = await localize("ast_failed_retry", tokenA);
  assert.equal(res.statusCode, 200, `重试成功应 200（实际 ${res.statusCode}：${res.body}）`);
  const body = res.json() as { asset?: Record<string, unknown> };
  assert.ok(body.asset, "响应必须是 { asset } 包装");
  assert.equal(fetchCalls.length, 1, "恰一次下载");

  const row = readRow("ast_failed_retry");
  assert.ok(row);
  assert.equal(row.workspacePath, "media/ast_failed_retry.png", "failed 行 path 为 null → 扩展名按 kind 兜底 png");
  assert.equal(row.mimeType, "image/jpeg", "Content-Type 命中白名单且与 DB 不符 → 兜正 mimeType");
  const loc = readLocalization("ast_failed_retry");
  assert.equal(loc?.state, "ready");
  assert.equal(loc?.bytes, OK_BYTES.length, "ready 必有 bytes 在案");
  assert.equal(typeof loc?.at, "string");
  assert.equal(body.asset!.workspacePath, row.workspacePath, "响应 asset 与 DB 一致");

  const abs = join(dir, "workspaces", wsIdA, "media/ast_failed_retry.png");
  assert.ok(existsSync(abs), "文件必须真实落盘");
  assert.ok(readBytesIf(abs)?.equals(OK_BYTES), "落盘字节与下载一致");
  const parts = readdirSync(join(dir, "workspaces", wsIdA, "media")).filter((f) => f.endsWith(".part"));
  assert.deepEqual(parts, [], "rename 后 media/ 下不得残留 .part 半文件");
});

test("全失败：422 + error 文案；DB 状态先收敛 failed+error 在案（path 保持 null）；4 次尝试 + 500/2000/8000 退避", async () => {
  fetchCalls = [];
  sleepCalls = [];
  const res = await localize("ast_dead", tokenA);
  assert.equal(res.statusCode, 422, `全失败应 422（实际 ${res.statusCode}：${res.body}）`);
  const err = (res.json() as { error: { code: string; message: string } }).error;
  assert.equal(err.code, "LOCALIZE_FAILED");
  assert.ok(err.message.length > 0, "响应体带 error 文案（spec §6）");
  assert.equal(fetchCalls.length, 4, "首次 + 3 次重试共 4 次尝试");
  assert.deepEqual(sleepCalls, [500, 2000, 8000], "退避序列（注入 sleep 记录真实毫秒值）");

  const row = readRow("ast_dead");
  assert.ok(row);
  assert.equal(row.workspacePath, null, "失败不得写 workspacePath");
  const loc = readLocalization("ast_dead");
  assert.equal(loc?.state, "failed", "回话前 DB 状态已收敛（与 worker 宽落库语义对齐）");
  assert.ok(loc?.error && loc.error.length > 0, "error 在案");
});

test("b64 直出资产（url null）→ 400 单独文案，且不落任何 localization 键", async () => {
  fetchCalls = [];
  const res = await localize("ast_b64", tokenA);
  assert.equal(res.statusCode, 400, `无远程地址应 400（实际 ${res.statusCode}：${res.body}）`);
  assert.equal(
    (res.json() as { error: { message: string } }).error.message,
    "该资产无可下载的远程地址",
  );
  assert.equal(fetchCalls.length, 0);
  assert.equal(readLocalization("ast_b64"), undefined, "400 分支绝不写 localization 键");
});

test("404 同构：越权/不存在/他人 b64 三态响应体逐字一致（封堵存在性 oracle），越权零下载", async () => {
  fetchCalls = [];
  const expected = { error: { code: "NOT_FOUND", message: "资产不存在或不可访问" } };
  const foreign = await localize("ast_foreign", tokenB);
  const ghost = await localize("ast_ghost_not_exists", tokenA);
  const foreignB64 = await localize("ast_foreign_b64", tokenB);
  assert.equal(foreign.statusCode, 404);
  assert.equal(ghost.statusCode, 404);
  assert.equal(
    foreignB64.statusCode,
    404,
    "T4 Important-1：他人 b64 行必须 404 而非 400——400 会泄露「该行无远程地址」，判空不得先于归属",
  );
  assert.deepEqual(foreign.json(), expected, "越权体必须与 media 路由同款同构（Task 3 三态纪律）");
  assert.deepEqual(ghost.json(), expected);
  assert.deepEqual(foreignB64.json(), expected);
  assert.equal(fetchCalls.length, 0, "越权绝不走到 url 判空/下载那步");
  assert.equal(readLocalization("ast_foreign")?.state, "failed", "越权请求不得改动 A 的资产状态");
});

test("扩展名沿用既有命名：media/legacy.jpg → 重试落 media/ast_legacy.jpg；Content-Type 与 DB mime 一致零覆写", async () => {
  const res = await localize("ast_legacy", tokenA);
  assert.equal(res.statusCode, 200, `旧路径资产重试应 200（实际 ${res.statusCode}：${res.body}）`);
  const row = readRow("ast_legacy");
  assert.ok(row);
  assert.equal(row.workspacePath, "media/ast_legacy.jpg", "扩展名沿用旧 workspacePath 的 jpg，而非 kind 兜底 png");
  assert.equal(row.mimeType, "image/jpeg", "Content-Type 与 DB mimeType 一致 → 不改写该列");
  assert.equal(readLocalization("ast_legacy")?.state, "ready");
  assert.ok(existsSync(join(dir, "workspaces", wsIdA, "media/ast_legacy.jpg")));
});

// ================= DELETE 文件清理 =================

test("DELETE ready 资产：DB 行消失且 media/ 文件被物理删除", async () => {
  const abs = join(dir, "workspaces", wsIdA, "media/ast_del_ready.png");
  assert.ok(existsSync(abs), "前置：文件在盘");
  const res = await app.inject({
    method: "DELETE",
    url: "/api/assets/ast_del_ready",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200, `删除应 200（实际 ${res.statusCode}：${res.body}）`);
  assert.equal(readRow("ast_del_ready"), undefined, "DB 行必须消失");
  assert.ok(!existsSync(abs), "本特性产物（media/ 前缀）必须物理删除");
});

test("DELETE failed（path null）不炸；DELETE ready 但文件丢失（ENOENT）也 200——文件失败绝不改响应", async () => {
  const del = async (id: string) =>
    app.inject({ method: "DELETE", url: `/api/assets/${id}`, headers: { authorization: `Bearer ${tokenA}` } });
  const failed = await del("ast_del_failed");
  assert.equal(failed.statusCode, 200, `failed 行（无 path）删除应 200（实际 ${failed.body}）`);
  assert.equal(readRow("ast_del_failed"), undefined);
  const gone = await del("ast_del_gone");
  assert.equal(gone.statusCode, 200, "unlink ENOENT 必须吞掉（记日志），不得 500");
  assert.equal(readRow("ast_del_gone"), undefined);
});

test("DELETE 非 media/ 前缀路径（用户手放）：DB 删但文件保留（保守，只清本特性产物）", async () => {
  const abs = join(dir, "workspaces", wsIdA, "notes/manual.png");
  const res = await app.inject({
    method: "DELETE",
    url: "/api/assets/ast_del_manual",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(readRow("ast_del_manual"), undefined);
  assert.ok(existsSync(abs), "非 media/ 前缀路径绝不代删用户文件");
});

test("DELETE 越权：B 删 A 的资产 → 404，行与文件都保留", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: "/api/assets/ast_foreign",
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(res.statusCode, 404, `越权删除应 404（实际 ${res.statusCode}：${res.body}）`);
  assert.ok(readRow("ast_foreign"), "越权请求不得删任何行");
});

/** 存在才读字节（不存在返回 undefined，让断言以清晰 diff 失败而非抛 ENOENT） */
function readBytesIf(abs: string): Buffer | undefined {
  return existsSync(abs) ? readFileSync(abs) : undefined;
}
