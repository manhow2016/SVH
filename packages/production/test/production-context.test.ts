/**
 * ProductionContext（V0.3 Phase 1）测试。
 *
 * 验证：
 * 1. 按角色加载最小相关投影（director/script/storyboard），不把整个项目塞进 Context；
 * 2. 剧本选择：优先已审核版本，否则取最新；
 * 3. 渲染：构成 System Prompt 追加块、长内容截断、空字段不输出。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeProductionRepository } from "./helpers/fake-repository";
import {
  ProductionService,
  ProductionContextResolver,
  renderProductionContext,
  type ProductionContext,
} from "../src/index";

let repo: FakeProductionRepository;
let service: ProductionService;
let resolver: ProductionContextResolver;

beforeEach(() => {
  repo = new FakeProductionRepository();
  service = new ProductionService(repo);
  resolver = new ProductionContextResolver(service);
});

/** 建一个含项目/剧本/角色/场景的完整项目，返回 projectId 与角色 id */
async function seedFullProject() {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({
    workspaceId: "ws_1",
    name: "仙侠短剧第一集",
    type: "short_drama",
    settings: { duration: 120, style: "chinese_fantasy" },
  });
  const script = await service.createScript({
    projectId: project.id,
    title: "第一集",
    content: "SCENE 1\n古风女侠立于飞檐之上。",
  });
  // 通过 草稿→审核→通过 流程把剧本批准
  await service.updateScript(script.id, { status: "reviewing" });
  await service.updateScript(script.id, { status: "approved" });
  const charA = await service.createCharacter({
    projectId: project.id,
    name: "风灵",
    description: "女主角，剑侠",
    appearance: { gender: "女", hairstyle: "长发", clothing: "白蓝长袍" },
  });
  const sceneA = await service.createScene({
    projectId: project.id,
    name: "飞檐夜色",
    description: "月光之下，女侠立于飞檐",
    location: "皇宫飞檐",
    time: "夜晚",
    characters: [charA.id],
  });
  return { projectId: project.id, scriptId: script.id, sceneId: sceneA.id, charAId: charA.id };
}

test("director 角色只加载项目上下文，不加载剧本/角色/场景", async () => {
  const { projectId } = await seedFullProject();
  {
    const ctx = await resolver.resolve({ projectId, role: "director" });
    assert.equal(ctx.project.name, "仙侠短剧第一集");
    assert.equal(ctx.project.type, "short_drama");
    assert.equal(ctx.project.targetDuration, 120);
    assert.equal(ctx.project.visualStyle, "chinese_fantasy");
    assert.equal(ctx.script, undefined);
    assert.equal(ctx.characters.length, 0);
    assert.equal(ctx.scenes.length, 0);
  }
});

test("script 角色加载项目 + 剧本 + 角色，不加载场景", async () => {
  const { projectId, scriptId } = await seedFullProject();
  const ctx = await resolver.resolve({ projectId, role: "script" });
  assert.equal(ctx.script?.scriptId, scriptId);
  assert.equal(ctx.script?.status, "approved");
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.scenes.length, 0);
});

test("storyboard 角色加载项目 + 剧本 + 角色 + 场景，且场景按角色名解析在场角色", async () => {
  const { projectId, scriptId } = await seedFullProject();
  const ctx = await resolver.resolve({ projectId, role: "storyboard" });
  assert.equal(ctx.script?.scriptId, scriptId);
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.scenes.length, 1);
  assert.equal(ctx.scenes[0]!.characters[0], "风灵"); // id 已解析为角色名
});

test("剧本选择优先已审核版本", async () => {
  const { projectId } = await seedFullProject();
  // 追加一个草稿剧本（版本更高版本号）
  const draftScript = await service.createScript({
    projectId,
    title: "第二版",
    content: "SCENE 1\n（新版本草稿）",
  });
  const ctx = await resolver.resolve({ projectId, role: "storyboard" });
  // 已审核的旧版被优先选中（而非最新草稿）
  assert.notEqual(ctx.script?.scriptId, draftScript.id);
  assert.equal(ctx.script?.status, "approved");
});

test("无剧本时 script 角色渲染不含 Script 段", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "空项目" });
  const ctx = await resolver.resolve({ projectId: project.id, role: "script" });
  const text = renderProductionContext(ctx);
  assert.ok(text.includes("Production Context: Project"));
  assert.ok(!text.includes("Production Context: Script"));
  assert.ok(!text.includes("Production Context: Characters"));
});

test("渲染：长剧本正文按上限截断并标注", () => {
  const ctx: ProductionContext = {
    project: { projectId: "p1", name: "项目", type: "short_drama", status: "draft" },
    script: { scriptId: "s1", title: "长剧本", version: 1, status: "approved", content: "甲".repeat(8000) },
    characters: [],
    scenes: [],
    storyboards: [],
    shots: [],
  };
  const text = renderProductionContext(ctx);
  assert.ok(text.includes("已截断"));
  assert.ok(text.includes("Production Context: Script"));
});

test("渲染：多个角色/场景/分镜按顺序输出", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({
    workspaceId: "ws_1",
    name: "项目",
    settings: { style: "cinematic" },
  });
  const script = await service.createScript({ projectId: project.id, title: "剧本", content: "SCENE 1" });
  await service.updateScript(script.id, { status: "reviewing" });
  await service.updateScript(script.id, { status: "approved" });
  await service.createCharacter({ projectId: project.id, name: "角色一", description: "主角" });
  await service.createCharacter({ projectId: project.id, name: "角色二", description: "配角" });
  const s1 = await service.createScene({ projectId: project.id, name: "场景A", description: "desc A" });
  await service.createStoryboard({
    projectId: project.id,
    sceneId: s1.id,
    description: "分镜一",
    duration: 5,
    shotType: "medium_shot",
  });
  const ctx = await resolver.resolve({ projectId: project.id, role: "storyboard" });
  const text = renderProductionContext(ctx);
  assert.ok(text.includes("角色一"));
  assert.ok(text.includes("角色二"));
  assert.ok(text.includes("场景A"));
  assert.ok(text.includes("分镜一"));
  assert.ok(text.includes("视觉风格：cinematic"));
});
