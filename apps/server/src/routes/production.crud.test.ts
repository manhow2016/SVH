/**
 * 制作中心 CRUD 路由 HTTP 集成测试（V0.3 整体完善：删除 / 单实体 GET / 字段透传 / 资产手动录入）。
 *
 * 复用 generation 路由测试基建：真实临时库（mkdtemp）+ buildApp + app.inject，
 * 全程零外呼（本测试只走 HTTP 落库，不启 worker）。
 *
 * 覆盖：
 * - 剧本/角色/场景/分镜/镜头：删除 200 + 重复删/不存在 404 + 越权 404 + 单实体 GET
 * - 字段透传 round-trip：角色 visualProfile、场景/镜头 visualStyle、分镜 order/status、镜头规格
 * - 场景删除级联清掉其分镜/镜头（DB 外键）
 * - 资产：手动录入 → GET → 编辑（name/type/url）→ 删除
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

let tokenA: string; // 制作中心主用户
let tokenB: string; // 越权用户（只用于「越权 404」用例）
let projectId: string;

/** 统一走 HTTP 的 inject 小工具（自动带 Bearer；支持 DELETE/PATCH） */
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

/** 注册 + 登录，返回登录 token */
async function register(username: string): Promise<string> {
  const res = await call("POST", "/api/auth/register", {
    body: { username, email: `${username}@crud.local`, password: "Crud12345" },
  });
  assert.equal(res.statusCode, 201, `注册 ${username} 应 201（实际 ${res.statusCode}：${res.body}）`);
  const login = await call("POST", "/api/auth/login", {
    body: { identifier: username, password: "Crud12345" },
  });
  assert.equal(login.statusCode, 200, `登录 ${username} 应 200（实际 ${login.statusCode}：${login.body}）`);
  return (login.json() as { token: string }).token;
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

/** 断言 HTTP 404（越权/不存在统一隐藏存在性） */
function assertNotFound(res: { statusCode: number }): void {
  assert.equal(res.statusCode, 404, `应 404（实际 ${res.statusCode}）`);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-crud-route-"));
  const config: AppConfig = {
    port: 0,
    databaseUrl: join(dir, "test.db"),
    workspaceRoot: join(dir, "workspaces"),
    assetsRoot: join(dir, "assets"),
    corsOrigin: "http://localhost:5173",
    llm: { baseUrl: "", apiKey: "", model: "" },
    jwtSecret: "crud-test-secret",
    admin: { username: "admin", password: "admin123456", email: "admin@svh.local" },
  };
  app = await buildApp(config, { logger: false });

  tokenA = await register("crud-a");
  tokenB = await register("crud-b");
  projectId = await createProject(tokenA, "制作中心");
});

after(async () => {
  if (app) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("剧本：创建 → 单实体 GET → 删除 → 再删 404 → 越权 404", async () => {
  const create = await call("POST", `/api/projects/${projectId}/scripts`, {
    token: tokenA,
    body: { title: "第一集", content: "SCENE 1 白天 街道\n主角登场" },
  });
  assert.equal(create.statusCode, 200);
  const script = create.json() as { id: string; title: string };
  assert.equal(script.title, "第一集");

  const get = await call("GET", `/api/scripts/${script.id}`, { token: tokenA });
  assert.equal(get.statusCode, 200);
  assert.equal((get.json() as { title: string }).title, "第一集");

  // 越权: tokenB 不应能读/删 A 的剧本
  assertNotFound(await call("GET", `/api/scripts/${script.id}`, { token: tokenB }));
  assertNotFound(await call("DELETE", `/api/scripts/${script.id}`, { token: tokenB }));

  const del = await call("DELETE", `/api/scripts/${script.id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);
  assertNotFound(await call("GET", `/api/scripts/${script.id}`, { token: tokenA }));
  assertNotFound(await call("DELETE", `/api/scripts/${script.id}`, { token: tokenA }));
});

test("角色：创建带 visualProfile/referenceAssetId 透传 → 更新 → 删除", async () => {
  const create = await call("POST", `/api/projects/${projectId}/characters`, {
    token: tokenA,
    body: {
      name: "主角",
      description: "核心角色",
      personality: "勇敢",
      appearance: { gender: "男", age: "青年" },
      referenceAssetId: "ast_ref_1",
      visualProfile: {
        appearancePrompt: "干净利落的短发",
        identityPrompt: "东方青年",
        costumePrompt: "青蓝色古装",
        negativePrompt: "扭曲、模糊",
        referenceAssetIds: ["ast_ref_1", "ast_ref_2"],
      },
    },
  });
  assert.equal(create.statusCode, 200);
  const character = create.json() as { id: string; visualProfile?: Record<string, unknown>; referenceAssetId?: string };
  assert.equal(character.referenceAssetId, "ast_ref_1");
  assert.equal(character.visualProfile?.appearancePrompt, "干净利落的短发");
  assert.ok(Array.isArray(character.visualProfile?.referenceAssetIds));
  assert.deepEqual(character.visualProfile?.referenceAssetIds, ["ast_ref_1", "ast_ref_2"]);

  // 单实体 GET + 更新（改名 + 视觉档案覆盖）
  const get = await call("GET", `/api/characters/${character.id}`, { token: tokenA });
  assert.equal(get.statusCode, 200);
  const patch = await call("PATCH", `/api/characters/${character.id}`, {
    token: tokenA,
    body: { name: "男主角", visualProfile: { appearancePrompt: "新描述", referenceAssetIds: ["ast_ref_3"] } },
  });
  assert.equal(patch.statusCode, 200);
  const updated = patch.json() as { name: string; visualProfile: Record<string, unknown> };
  assert.equal(updated.name, "男主角");
  assert.equal(updated.visualProfile.appearancePrompt, "新描述");
  assert.deepEqual(updated.visualProfile.referenceAssetIds, ["ast_ref_3"]);

  const del = await call("DELETE", `/api/characters/${character.id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);
  assertNotFound(await call("GET", `/api/characters/${character.id}`, { token: tokenA }));
});

test("场景：创建带 visualStyle 透传 → 级联删除清其分镜/镜头", async () => {
  const createScene = await call("POST", `/api/projects/${projectId}/scenes`, {
    token: tokenA,
    body: {
      name: "古代街道",
      description: "黄昏街头",
      location: "长安城",
      time: "黄昏",
      visualStyle: { styleName: "国风", lighting: "暖光", colorTone: "暖黄" },
      characters: ["chr_1", "chr_2"],
    },
  });
  assert.equal(createScene.statusCode, 200);
  const scene = createScene.json() as {
    id: string;
    visualStyle?: Record<string, unknown>;
    characters: string[];
  };
  assert.equal(scene.visualStyle?.styleName, "国风");
  assert.deepEqual(scene.characters, ["chr_1", "chr_2"]);

  const createSb = await call("POST", `/api/projects/${projectId}/storyboards`, {
    token: tokenA,
    body: { sceneId: scene.id, description: "街头全景", duration: 5, shotType: "wide_shot", order: 0 },
  });
  assert.equal(createSb.statusCode, 200);
  const storyboard = createSb.json() as { id: string; order: number };
  assert.equal(storyboard.order, 0);

  const createShot = await call("POST", `/api/projects/${projectId}/shots`, {
    token: tokenA,
    body: { storyboardId: storyboard.id, duration: 3, framing: "medium", action: "主角走过", dialogue: "你好" },
  });
  assert.equal(createShot.statusCode, 200);
  const shot = createShot.json() as { id: string; framing: string; action: string };
  assert.equal(shot.framing, "medium");
  assert.equal(shot.action, "主角走过");

  // 删除场景 → 其分镜/镜头一并删除（外键级联）
  const del = await call("DELETE", `/api/scenes/${scene.id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);
  assertNotFound(await call("GET", `/api/scenes/${scene.id}`, { token: tokenA }));
  assertNotFound(await call("GET", `/api/storyboards/${storyboard.id}`, { token: tokenA }));
  assertNotFound(await call("GET", `/api/shots/${shot.id}`, { token: tokenA }));
});

test("分镜：创建带 order/status 透传 → 更新 order → 删除", async () => {
  const sceneRes = await call("POST", `/api/projects/${projectId}/scenes`, {
    token: tokenA,
    body: { name: "内景", description: "室内", order: 5 },
  });
  const scene = sceneRes.json() as { id: string };

  const create = await call("POST", `/api/projects/${projectId}/storyboards`, {
    token: tokenA,
    body: {
      sceneId: scene.id,
      description: "镜头描述",
      duration: 6,
      shotType: "close_up",
      imagePrompt: "深夜古宅",
      videoPrompt: "镜头缓缓推进",
      status: "draft",
      order: 3,
    },
  });
  assert.equal(create.statusCode, 200);
  const storyboard = create.json() as { id: string; order: number; imagePrompt: string };
  assert.equal(storyboard.order, 3);
  assert.equal(storyboard.imagePrompt, "深夜古宅");

  const patch = await call("PATCH", `/api/storyboards/${storyboard.id}`, {
    token: tokenA,
    body: { order: 9 },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal((patch.json() as { order: number }).order, 9);

  const del = await call("DELETE", `/api/storyboards/${storyboard.id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);
  assertNotFound(await call("GET", `/api/storyboards/${storyboard.id}`, { token: tokenA }));
});

test("镜头：创建带 visualStyle/规格透传 → 更新规格 → 删除", async () => {
  const sceneRes = await call("POST", `/api/projects/${projectId}/scenes`, {
    token: tokenA,
    body: { name: "场景B", description: "描述B" },
  });
  const scene = sceneRes.json() as { id: string };
  const sbRes = await call("POST", `/api/projects/${projectId}/storyboards`, {
    token: tokenA,
    body: { sceneId: scene.id, description: "分镜B", duration: 8, shotType: "tracking" },
  });
  const storyboard = sbRes.json() as { id: string };

  const create = await call("POST", `/api/projects/${projectId}/shots`, {
    token: tokenA,
    body: {
      storyboardId: storyboard.id,
      duration: 4,
      order: 1,
      framing: "wide",
      cameraMovement: "dolly",
      action: "主角进门",
      dialogue: "我回来了",
      visualStyle: { styleName: "冷色调", colorTone: "偏蓝" },
    },
  });
  assert.equal(create.statusCode, 200);
  const shot = create.json() as {
    id: string;
    framing: string;
    cameraMovement: string;
    dialogue: string;
    visualStyle?: Record<string, unknown>;
  };
  assert.equal(shot.framing, "wide");
  assert.equal(shot.cameraMovement, "dolly");
  assert.equal(shot.dialogue, "我回来了");
  assert.equal(shot.visualStyle?.styleName, "冷色调");

  const patch = await call("PATCH", `/api/shots/${shot.id}`, {
    token: tokenA,
    body: { action: "主角关门", duration: 3 },
  });
  assert.equal(patch.statusCode, 200);
  const updated = patch.json() as { action: string; duration: number };
  assert.equal(updated.action, "主角关门");
  assert.equal(updated.duration, 3);

  const del = await call("DELETE", `/api/shots/${shot.id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);
  assertNotFound(await call("GET", `/api/shots/${shot.id}`, { token: tokenA }));
});

test("资产：手动录入 → GET → 编辑名称/类型/URL → 删除", async () => {
  const create = await call("POST", `/api/projects/${projectId}/assets`, {
    token: tokenA,
    body: { type: "image", name: "参考图", url: "https://example.com/a.png", mimeType: "image/png" },
  });
  assert.equal(create.statusCode, 200);
  const asset = create.json() as { id: string; name: string; type: string; url: string; mimeType: string };
  assert.equal(asset.name, "参考图");
  assert.equal(asset.type, "image");
  assert.equal(asset.mimeType, "image/png");

  const get = await call("GET", `/api/assets/${asset.id}`, { token: tokenA });
  assert.equal(get.statusCode, 200);
  assert.equal((get.json() as { name: string }).name, "参考图");

  const patch = await call("PATCH", `/api/assets/${asset.id}`, {
    token: tokenA,
    body: { name: "新参考图", type: "video", url: "https://example.com/b.mp4" },
  });
  assert.equal(patch.statusCode, 200);
  const updated = patch.json() as { name: string; type: string; url: string };
  assert.equal(updated.name, "新参考图");
  assert.equal(updated.type, "video");
  assert.equal(updated.url, "https://example.com/b.mp4");

  // 越权读 A 的资产 → 404
  assertNotFound(await call("GET", `/api/assets/${asset.id}`, { token: tokenB }));

  const del = await call("DELETE", `/api/assets/${asset.id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);
  assertNotFound(await call("GET", `/api/assets/${asset.id}`, { token: tokenA }));
});
