/**
 * Episode 路由测试（短剧多集 V0.3）。
 *
 * 覆盖：项目自动带第 1 集、建集/列表/改/删（最后一集拒删）、
 * 剧本/场景/时间轴按集过滤、自动时间轴按集、越权 404。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../app";
import type { AppConfig } from "../config/index";

let dir: string;
let app: FastifyInstance;
let tokenA: string;
let tokenB: string;
let projectId: string;

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

async function register(username: string): Promise<string> {
  await call("POST", "/api/auth/register", {
    body: { username, email: `${username}@ep.local`, password: "Crud12345" },
  });
  const login = await call("POST", "/api/auth/login", {
    body: { identifier: username, password: "Crud12345" },
  });
  return (login.json() as { token: string }).token;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-episode-route-"));
  const config: AppConfig = {
    port: 0,
    databaseUrl: join(dir, "test.db"),
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "episode-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });
  tokenA = await register("ep_a");
  tokenB = await register("ep_b");
  const pj = await call("POST", "/api/productions", {
    token: tokenA,
    body: { name: "多集项目", type: "short_drama" },
  });
  projectId = (pj.json() as { id: string }).id;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("项目创建自动带第 1 集；建集/列表/改名/删除", async () => {
  // 初始一集
  const list = await call("GET", `/api/projects/${projectId}/episodes`, { token: tokenA });
  assert.equal(list.statusCode, 200, list.body);
  const episodes = list.json() as Array<{ id: string; order: number; name: string }>;
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.order, 1);
  assert.equal(episodes[0]!.name, "第 1 集");

  // 建第 2 集
  const created = await call("POST", `/api/projects/${projectId}/episodes`, {
    token: tokenA,
    body: { name: "第二集" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const ep2 = created.json() as { id: string; order: number };
  assert.equal(ep2.order, 2);

  // 改名 + 集号校验（0 非法 → 400）
  const patched = await call("PATCH", `/api/episodes/${ep2.id}`, { token: tokenA, body: { order: 3 } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((patched.json() as { order: number }).order, 3);
  assert.equal(
    (await call("POST", `/api/projects/${projectId}/episodes`, { token: tokenA, body: { order: 0 } })).statusCode,
    400,
  );

  // 删除：剩 2 集（第 1 集 + order 3）→ 删第 2 集成功；再删最后一集 → 400
  const deleted = await call("DELETE", `/api/episodes/${ep2.id}`, { token: tokenA });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const last = (await call("GET", `/api/projects/${projectId}/episodes`, { token: tokenA })).json() as Array<{ id: string }>;
  assert.equal(last.length, 1);
  assert.equal(
    (await call("DELETE", `/api/episodes/${last[0]!.id}`, { token: tokenA })).statusCode,
    400,
  );
});

test("按集过滤：剧本 / 场景 / 时间轴 / 镜头（经场景链）", async () => {
  const episodes = (await call("GET", `/api/projects/${projectId}/episodes`, { token: tokenA })).json() as Array<{ id: string }>;
  const ep1 = episodes[0]!.id;
  const ep2 = ((await call("POST", `/api/projects/${projectId}/episodes`, { token: tokenA, body: {} })).json() as { id: string }).id;

  // 剧本：默认归第 1 集；显式归第 2 集
  await call("POST", `/api/projects/${projectId}/scripts`, { token: tokenA, body: { title: "第1集", content: "a" } });
  await call("POST", `/api/projects/${projectId}/scripts`, { token: tokenA, body: { title: "第2集", content: "b", episodeId: ep2 } });
  const scriptsE2 = (await call("GET", `/api/projects/${projectId}/scripts?episodeId=${ep2}`, { token: tokenA })).json() as Array<{ title: string }>;
  assert.deepEqual(scriptsE2.map((s) => s.title), ["第2集"]);

  // 场景（默认归第 1 集 + 显式第 2 集）
  await call("POST", `/api/projects/${projectId}/scenes`, { token: tokenA, body: { name: "s1", description: "d" } });
  const sc2 = await call("POST", `/api/projects/${projectId}/scenes`, { token: tokenA, body: { name: "s2", description: "d", episodeId: ep2 } });
  const sc2Id = (sc2.json() as { id: string }).id;
  const scenesE2 = (await call("GET", `/api/projects/${projectId}/scenes?episodeId=${ep2}`, { token: tokenA })).json() as Array<{ id: string }>;
  assert.deepEqual(scenesE2.map((s) => s.id), [sc2Id]);

  // 镜头链：第 2 集场景 → 分镜 → 镜头 → 按集过滤
  const sb = await call("POST", `/api/projects/${projectId}/storyboards`, { token: tokenA, body: { sceneId: sc2Id, description: "d", shotType: "medium", duration: 10 } });
  const sbId = (sb.json() as { id: string }).id;
  const shot = await call("POST", `/api/projects/${projectId}/shots`, { token: tokenA, body: { storyboardId: sbId, duration: 5 } });
  const shotId = (shot.json() as { id: string }).id;
  const shotsE1 = (await call("GET", `/api/projects/${projectId}/shots?episodeId=${ep1}`, { token: tokenA })).json() as Array<{ id: string }>;
  const shotsE2 = (await call("GET", `/api/projects/${projectId}/shots?episodeId=${ep2}`, { token: tokenA })).json() as Array<{ id: string }>;
  assert.deepEqual(shotsE1.map((s) => s.id), []);
  assert.deepEqual(shotsE2.map((s) => s.id), [shotId]);

  // 时间轴：默认归第 1 集 + 显式第 2 集
  const t1 = await call("POST", `/api/projects/${projectId}/timelines`, { token: tokenA, body: { name: "t1-轴" } });
  assert.equal((t1.json() as { episodeId: string | null }).episodeId, ep1);
  await call("POST", `/api/projects/${projectId}/timelines`, { token: tokenA, body: { name: "t2-轴", episodeId: ep2 } });
  const tlsE1 = (await call("GET", `/api/projects/${projectId}/timelines?episodeId=${ep1}`, { token: tokenA })).json() as Array<{ name: string }>;
  const tlsE2 = (await call("GET", `/api/projects/${projectId}/timelines?episodeId=${ep2}`, { token: tokenA })).json() as Array<{ name: string }>;
  assert.deepEqual(tlsE1.map((t) => t.name), ["t1-轴"]);
  assert.deepEqual(tlsE2.map((t) => t.name), ["t2-轴"]);
});

test("episode 越权一律 404；自动时间轴按集（body episodeId 透传）", async () => {
  const episodes = (await call("GET", `/api/projects/${projectId}/episodes`, { token: tokenA })).json() as Array<{ id: string }>;
  const ep2 = episodes.find((e) => e.id !== episodes[0]!.id)!.id;
  assertNotFound(await call("GET", `/api/projects/${projectId}/episodes`, { token: tokenB }));
  assertNotFound(await call("POST", `/api/projects/${projectId}/episodes`, { token: tokenB, body: { name: "x" } }));
  assertNotFound(await call("GET", `/api/episodes/${ep2}`, { token: tokenB }));
  assertNotFound(await call("PATCH", `/api/episodes/${ep2}`, { token: tokenB, body: { name: "x" } }));
  assertNotFound(await call("DELETE", `/api/episodes/${ep2}`, { token: tokenB }));
  // 自动时间轴：第 2 集无已就绪素材 → 400（说明按集取数路径生效；否则会扔「全项目无素材」以外逻辑）
  const auto = await call("POST", `/api/projects/${projectId}/timelines/auto`, { token: tokenA, body: { episodeId: ep2 } });
  assert.equal(auto.statusCode, 400, auto.body);
  assert.match(auto.body, /没有可用的已就绪视频素材/);
});

function assertNotFound(res: { statusCode: number }): void {
  assert.equal(res.statusCode, 404, `应 404（实际 ${res.statusCode}）`);
}
