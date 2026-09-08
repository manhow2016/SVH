/**
 * Visual Style（V0.3 Phase 4）测试。
 *
 * 覆盖：
 * 1. normalizeVisualStyleProfile（白名单 / 空对象返回 undefined / 非法结构）；
 * 2. resolveVisualStyle 优先级（Shot > Scene > Project > Global）与 legacy settings.style 回退；
 * 3. visualStyleToPrompt 渲染；
 * 4. StyleResolver 组合项目/场景/镜头；
 * 5. 项目设置/场景/镜头 visualStyle 的 service 持久化。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeProductionRepository } from "./helpers/fake-repository";
import {
  ProductionService,
  normalizeVisualStyleProfile,
  resolveVisualStyle,
  visualStyleToPrompt,
  StyleResolver,
} from "../src/index";

let repo: FakeProductionRepository;
let service: ProductionService;

beforeEach(() => {
  repo = new FakeProductionRepository();
  service = new ProductionService(repo);
});

function seedProject() {
  repo.seedOwner("ws_1", "usr_1");
  return service.createProject({
    workspaceId: "ws_1",
    name: "项目",
    settings: { duration: 90, style: "chinese_fantasy" },
  });
}

// ================= 规范化 =================

test("normalizeVisualStyleProfile：白名单文本，空对象返回 undefined，非法结构抛 VALIDATION", () => {
  const p = normalizeVisualStyleProfile({
    styleName: "Chinese fantasy",
    visualPrompt: "cinematic, moonlit",
    lighting: "soft",
    colorTone: "teal",
    cameraStyle: "slow push-in",
    renderingStyle: "3D",
    negativePrompt: "no watermark",
  });
  assert.equal(p?.styleName, "Chinese fantasy");
  assert.equal(p?.visualPrompt, "cinematic, moonlit");
  assert.equal(p?.cameraStyle, "slow push-in");

  assert.equal(normalizeVisualStyleProfile({}), undefined);
  assert.equal(normalizeVisualStyleProfile(undefined), undefined);
  assert.throws(() => normalizeVisualStyleProfile("x"), { code: "VALIDATION" });
  assert.throws(() => normalizeVisualStyleProfile({ visualPrompt: 123 }), { code: "VALIDATION" });
});

// ================= 优先级解析 =================

test("resolveVisualStyle：Shot > Scene > Project > Global，字段级覆盖继承", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({
    workspaceId: "ws_1",
    name: "项目",
    settings: {
      style: "legacy",
      visualStyle: { visualPrompt: "project style", lighting: "project light", colorTone: "blue" },
    },
  });
  const scene = await service.createScene({
    projectId: project.id,
    name: "场景",
    description: "d",
    visualStyle: { lighting: "scene light" },
  });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "分镜",
    duration: 6,
    shotType: "medium_shot",
  });
  const shot = await service.createShot({
    projectId: project.id,
    storyboardId: storyboard.id,
    duration: 3,
    visualStyle: { colorTone: "deep red", cameraStyle: "dolly" },
  });
  const effective = resolveVisualStyle({ project, scene, shot, globalDefault: { visualPrompt: "global" } });
  assert.equal(effective.visualPrompt, "project style", "项目层继承（覆盖 global）");
  assert.equal(effective.lighting, "scene light", "场景覆盖项目 lighting");
  assert.equal(effective.colorTone, "deep red", "镜头覆盖场景/项目的 colorTone");
  assert.equal(effective.cameraStyle, "dolly", "镜头 cameraStyle");
});

test("resolveVisualStyle：无 structured visualStyle 时回退 legacy settings.style", async () => {
  const project = await seedProject(); // settings.style = "chinese_fantasy"
  const effective = resolveVisualStyle({ project });
  assert.equal(effective.visualPrompt, "chinese_fantasy");
});

test("resolveVisualStyle：镜头覆盖继承时其它字段保持项目值", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({
    workspaceId: "ws_1",
    name: "项目",
    settings: { visualStyle: { visualPrompt: "wuxia", lighting: "moon", colorTone: "cold" } },
  });
  const scene = await service.createScene({ projectId: project.id, name: "s", description: "d" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "分镜",
    duration: 6,
    shotType: "medium_shot",
  });
  const shot = await service.createShot({
    projectId: project.id,
    storyboardId: storyboard.id,
    duration: 3,
    visualStyle: { lighting: "sunset" },
  });
  const effective = resolveVisualStyle({ project, scene, shot });
  assert.equal(effective.lighting, "sunset", "镜头覆盖 lighting");
  assert.equal(effective.visualPrompt, "wuxia", "未覆盖字段继承项目");
  assert.equal(effective.colorTone, "cold", "未覆盖字段继承项目");
});

// ================= 渲染 =================

test("visualStyleToPrompt：组装为风格 Prompt，忽略空字段", () => {
  const prompt = visualStyleToPrompt({ visualPrompt: "cinematic", lighting: "soft", cameraStyle: "push-in" });
  assert.equal(prompt, "cinematic, soft lighting, push-in");
  assert.equal(visualStyleToPrompt({}), undefined);
});

// ================= StyleResolver =================

test("StyleResolver.resolveForPrompt：加载项目/场景/镜头并返回风格 Prompt 与 negative", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({
    workspaceId: "ws_1",
    name: "项目",
    settings: { visualStyle: { visualPrompt: "cinematic", negativePrompt: "blurry" } },
  });
  const resolver = new StyleResolver(service);
  const resolved = await resolver.resolveForPrompt({ projectId: project.id });
  assert.equal(resolved.stylePrompt, "cinematic");
  assert.equal(resolved.negativePrompt, "blurry");
});

// ================= service 持久化 =================

test("项目 settings 持久化 visualStyle；场景/镜头 visualStyle 持久化", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({
    workspaceId: "ws_1",
    name: "项目",
    settings: { style: "x", visualStyle: { visualPrompt: "cinematic", lighting: "moon" } },
  });
  const reloaded = await service.getProject(project.id);
  assert.equal(reloaded.settings?.visualStyle?.visualPrompt, "cinematic");
  assert.equal(reloaded.settings?.visualStyle?.lighting, "moon");

  const scene = await service.createScene({
    projectId: project.id,
    name: "s",
    description: "d",
    visualStyle: { colorTone: "teal" },
  });
  assert.equal((await service.getScene(scene.id)).visualStyle?.colorTone, "teal");

  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "分镜",
    duration: 6,
    shotType: "medium_shot",
  });
  const shot = await service.createShot({
    projectId: project.id,
    storyboardId: storyboard.id,
    duration: 3,
    visualStyle: { cameraStyle: "dolly" },
  });
  assert.equal((await service.getShot(shot.id)).visualStyle?.cameraStyle, "dolly");
});
