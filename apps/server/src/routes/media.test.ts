/**
 * media 鉴权流式路由冒烟测试（Task 3：GET /api/media/:assetId?token=）。
 *
 * 只钉「送达契约面」（spec §5 + Task 2 入库契约）：
 * - ready 谓词 = workspacePath 非空 && metadata.localization.state === "ready"，不满足一律 404；
 * - 绝对路径 = resolveSafeWorkspacePath(join(config.workspaceRoot, asset.workspaceId), workspacePath)，
 *   root 带 wsId 段（与 WorkspaceManager rootPath 同形），测试真文件放 <workspaceRoot>/<wsId>/media/...；
 * - Content-Type 以 DB assets.mimeType 为准（Task 2 契约：文件名按 kind 先行兜底，真实类型靠 mime），
 *   mime 为空才按扩展名小表兜底，仍未知 → application/octet-stream；
 * - Range 单区间 206 / 超界 416 / 多区间按无 Range 200；无 Range 200；
 * - token 走 query：无/坏 401；他人（资产不可见）404，不泄露存在性；
 * - stat 失败或目录伪装 → 410（曾 ready 但文件丢失）；
 * - 逃逸钉：DB 直插 ../../ 模拟篡改 → 路径解析层拒绝（400，理由见用例注释），绝不读到工作区外。
 *
 * harness 逐字参考 production.generation.test.ts：手工 AppConfig + buildApp({logger:false})
 * + inject + mkdtemp 真临时库；资产行走旁路第二连接 SQL 预置（media 无写入 API 可用）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createDatabase, productionAssets, type SVHDatabase } from "@svh/database";
import { LOCALIZE_METADATA_KEY, type LocalizeMetadata } from "@svh/production";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
// 旁路第二连接：media 资产没有写入 API（真实链路靠 worker 转存），测试只能直插预置行
let probe: SVHDatabase;

let tokenA: string; // 资产主人
let userIdA: string;
let tokenB: string; // 越权者
let wsIdA: string; // A 的工作区（真文件目录名 = wsId）
let projectIdA: string;

/** 主资产内容：42 字节，够 206 全谱（0-3 段、尾 10 字节段）与 Content-Length 一致性断言 */
const MAIN_BYTES = Buffer.from("SVH-ASSET-0123456789ABCDEFGHIJ0123456789AB");
/** 微文件内容：恰 5 字节，让 bytes=5- 落在「start ≥ 文件长」的 416 分支 */
const TINY_BYTES = Buffer.from("01234");

/** GET media 的小工具：token 走 query（前端 <img>/<video> 的唯一通路），headers 可附加 Range */
async function get(
  assetId: string,
  opts: { token?: string; range?: string } = {},
) {
  const qs = opts.token ? `?token=${encodeURIComponent(opts.token)}` : "";
  return app.inject({
    method: "GET",
    url: `/api/media/${assetId}${qs}`,
    headers: opts.range ? { range: opts.range } : undefined,
  });
}

/** 真文件落 <workspaceRoot>/<wsId>/<rel>（与 worker 转存目录同形） */
function writeMedia(rel: string, content: Buffer): void {
  const abs = join(dir, "workspaces", wsIdA, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** 预置一行资产（列名 snake_case；FK 开启，project/workspace/user 必须全真） */
async function seedAsset(input: {
  id: string;
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
    url: "https://remote.example/expiring.png",
    workspacePath: input.workspacePath,
    mimeType: input.mimeType,
    metadata: input.localization
      ? ({ [LOCALIZE_METADATA_KEY]: input.localization } as Record<string, unknown>)
      : null,
    createdAt: now,
    updatedAt: now,
  });
}

const READY = (): LocalizeMetadata => ({ state: "ready", bytes: 1, at: "2026-09-07T00:00:00.000Z" });

/** 注册 + 登录（密码规则 ≥8 位含字母数字），返回 token 与 userId */
async function register(username: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, email: `${username}@media.local`, password: "Media12345" },
  });
  assert.equal(res.statusCode, 201, `注册 ${username} 应 201（实际 ${res.body}）`);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { identifier: username, password: "Media12345" },
  });
  assert.equal(login.statusCode, 200, `登录 ${username} 应 200（实际 ${login.body}）`);
  const body = login.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

/** 建工作区 + 生产项目（POST 响应即含 id，与 generation 冒烟同形） */
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
  dir = mkdtempSync(join(tmpdir(), "svh-media-route-"));
  const databaseUrl = join(dir, "test.db");
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "media-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });
  probe = createDatabase(databaseUrl);

  const a = await register("media-a");
  tokenA = a.token;
  userIdA = a.userId;
  tokenB = (await register("media-b")).token;
  const proj = await createProject(tokenA, "媒体项目");
  wsIdA = proj.wsId;
  projectIdA = proj.projectId;

  // 预置资产家族：一行一语义，互不干扰
  writeMedia("media/main.png", MAIN_BYTES); // DB mime=image/jpeg → 钉「mime 优先于扩展名」
  await seedAsset({
    id: "ast_main",
    workspacePath: "media/main.png",
    mimeType: "image/jpeg",
    localization: READY(),
  });
  writeMedia("media/tiny.png", TINY_BYTES); // 5 字节 → 0-3 切片与 416 分支
  await seedAsset({
    id: "ast_tiny",
    workspacePath: "media/tiny.png",
    mimeType: "image/png",
    localization: READY(),
  });
  writeMedia("media/plain.png", Buffer.from("PNGNOSTYPE")); // mime 空 → 扩展名兜底 png
  await seedAsset({
    id: "ast_nomime",
    workspacePath: "media/plain.png",
    mimeType: null,
    localization: READY(),
  });
  writeMedia("media/clip.xyz", Buffer.from("WEIRD")); // mime 空 + 未知扩展 → octet-stream
  await seedAsset({
    id: "ast_xyz",
    workspacePath: "media/clip.xyz",
    mimeType: null,
    localization: READY(),
  });
  // failed（worker 契约：failed 行 workspacePath 恒 null）→ 404
  await seedAsset({
    id: "ast_failed",
    workspacePath: null,
    mimeType: "image/png",
    localization: { state: "failed", error: "下载超时", at: "2026-09-07T00:00:00.000Z" },
  });
  // ready 但文件从未落盘（模拟磁盘丢失）→ 410
  await seedAsset({
    id: "ast_gone",
    workspacePath: "media/gone.png",
    mimeType: "image/png",
    localization: READY(),
  });
  // ready 但路径指向目录（伪装文件）→ 410
  mkdirSync(join(dir, "workspaces", wsIdA, "media/adir"), { recursive: true });
  await seedAsset({
    id: "ast_dir",
    workspacePath: "media/adir",
    mimeType: "image/png",
    localization: READY(),
  });
  // 逃逸钉：DB 直插绕过写入层校验模拟篡改；工作区外放一个真文件，绝不允许被读出
  writeFileSync(join(dir, "escape.txt"), Buffer.from("OUTSIDE-SECRET"));
  await seedAsset({
    id: "ast_escape",
    workspacePath: "../../escape.txt",
    mimeType: "image/png",
    localization: READY(),
  });
  // 无 localization 键（远程模式旧资产）→ 404
  await seedAsset({ id: "ast_remote", workspacePath: "media/main.png", mimeType: "image/png", localization: null });
});

after(async () => {
  try {
    probe?.$client.close();
    if (app) await app.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 成功路径与 Content-Type 契约 =================

test("ready 资产本人带 token → 200：字节全等、Content-Length 与实际一致、Content-Type 取 DB mimeType（.png 名存 jpeg）", async () => {
  const res = await get("ast_main", { token: tokenA });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.length, MAIN_BYTES.length, "Content-Length 必须钉住实际送达字节（防 stat 后截断漂移）");
  assert.equal(res.headers["content-length"], String(MAIN_BYTES.length));
  assert.ok(MAIN_BYTES.equals(res.rawPayload), "响应体必须与文件字节全等");
  // Task 2 契约：文件名按 kind 先行兜底（.png），真实类型以 DB mimeType 为准
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.headers["accept-ranges"], "bytes");
});

test("mimeType 为空 → 按扩展名兜底（.png → image/png）", async () => {
  const res = await get("ast_nomime", { token: tokenA });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
});

test("mimeType 为空且扩展名未知（.xyz）→ application/octet-stream", async () => {
  const res = await get("ast_xyz", { token: tokenA });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/octet-stream");
});

// ================= Range 语义 =================

test("Range bytes=0-3 → 206 + Content-Range + 恰 4 字节", async () => {
  const res = await get("ast_tiny", { token: tokenA, range: "bytes=0-3" });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-range"], `bytes 0-3/${TINY_BYTES.length}`);
  assert.equal(res.headers["content-length"], "4");
  assert.equal(res.rawPayload.toString(), "0123");
});

test("Range bytes=5-（start ≥ 文件长）→ 416 + Content-Range: bytes */len", async () => {
  const res = await get("ast_tiny", { token: tokenA, range: "bytes=5-" });
  assert.equal(res.statusCode, 416);
  assert.equal(res.headers["content-range"], `bytes */${TINY_BYTES.length}`);
});

test("Range 尾段 bytes=<len-10>- → 206 + 恰 10 字节（视频拖动模拟）", async () => {
  const res = await get("ast_main", { token: tokenA, range: `bytes=${MAIN_BYTES.length - 10}-` });
  assert.equal(res.statusCode, 206);
  assert.equal(res.rawPayload.length, 10);
  assert.ok(res.rawPayload.equals(MAIN_BYTES.subarray(MAIN_BYTES.length - 10)));
  assert.equal(
    res.headers["content-range"],
    `bytes ${MAIN_BYTES.length - 10}-${MAIN_BYTES.length - 1}/${MAIN_BYTES.length}`,
  );
});

test("Range 多区间（bytes=0-1,3-4）→ 按无 Range 处理：200 全量", async () => {
  const res = await get("ast_tiny", { token: tokenA, range: "bytes=0-1,3-4" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.rawPayload.equals(TINY_BYTES));
});

test("Range 语法坏（bytes=abc）→ 416", async () => {
  const res = await get("ast_main", { token: tokenA, range: "bytes=abc" });
  assert.equal(res.statusCode, 416);
});

// ================= 鉴权与归属 =================

test("无 token → 401 且是 ServerError 形状（web 端 error.code 兼容）", async () => {
  const res = await get("ast_main");
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as { error: { code: string } }).error.code, "UNAUTHORIZED");
});

test("坏 token（签名不过）→ 401", async () => {
  const res = await get("ast_main", { token: "not.a.jwt" });
  assert.equal(res.statusCode, 401);
});

test("他人 token → 404（与不存在同码，不泄露存在性）", async () => {
  const res = await get("ast_main", { token: tokenB });
  assert.equal(res.statusCode, 404);
  const ghost = await get("ast_does_not_exist", { token: tokenA });
  assert.equal(ghost.statusCode, 404, "不存在的资产应与越权同为 404");
});

// ================= 谓词与文件状态 =================

test("failed 资产（无 workspacePath）→ 404；无 localization 键（远程模式）→ 404", async () => {
  const failed = await get("ast_failed", { token: tokenA });
  assert.equal(failed.statusCode, 404);
  const remote = await get("ast_remote", { token: tokenA });
  assert.equal(remote.statusCode, 404);
});

test("ready 但磁盘文件缺失 → 410（曾 ready 现丢失，前端引导重新转存）", async () => {
  const res = await get("ast_gone", { token: tokenA });
  assert.equal(res.statusCode, 410);
  assert.ok((res.json() as { error: { code: string } }).error.code);
});

test("ready 但路径指向目录（伪装文件）→ 410 拒读", async () => {
  const res = await get("ast_gone", { token: tokenA });
  assert.equal(res.statusCode, 410);
  const dirRes = await get("ast_dir", { token: tokenA });
  assert.equal(dirRes.statusCode, 410, "目录不是可送达文件，按丢失处理");
});

test("逃逸钉：workspacePath 被篡改为 ../../escape.txt → 400（选 400 不选 404：归属校验在先，400 不泄露他人存在性；数据完整性错误显式报出便于排查），绝不读出工作区外字节", async () => {
  const res = await get("ast_escape", { token: tokenA });
  assert.equal(res.statusCode, 400, "resolveSafeWorkspacePath 越界抛 WorkspaceError → normalizeError 天然 400");
  assert.ok(!res.body.includes("OUTSIDE-SECRET"), "任何情况下不得把工作区外文件内容带出");
});
