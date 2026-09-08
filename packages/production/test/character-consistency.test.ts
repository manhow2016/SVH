/**
 * Character Consistency（V0.3 Phase 3）测试。
 *
 * 覆盖：
 * 1. CharacterVisualProfile 规范化（白名单 / referenceAssetIds / 空对象返回 undefined）；
 * 2. deriveCharacterPromptAnchor（确定性、优先 visualProfile、外观兜底组装）；
 * 3. ReferenceResolver（角色→参考资产、Provider 能力判定、回退 Anchor、缺失参考跳过）；
 * 4. toCharacterPromptSnippets（映射为 Composer 片段，带稳定 anchor）；
 * 5. context 投影携带 anchor。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeProductionRepository } from "./helpers/fake-repository";
import {
  ProductionService,
  deriveCharacterPromptAnchor,
  normalizeVisualProfile,
  ReferenceResolver,
  toCharacterPromptSnippets,
  ProductionContextResolver,
} from "../src/index";

let repo: FakeProductionRepository;
let service: ProductionService;

beforeEach(() => {
  repo = new FakeProductionRepository();
  service = new ProductionService(repo);
});

function seedProject() {
  repo.seedOwner("ws_1", "usr_1");
  return service.createProject({ workspaceId: "ws_1", name: "项目", settings: { style: "cinematic" } });
}

// ================= 视觉档案规范化 =================

test("normalizeVisualProfile：白名单文本 + referenceAssetIds，空对象返回 undefined", () => {
  const p = normalizeVisualProfile({
    appearancePrompt: " young Chinese swordswoman ",
    identityPrompt: "sharp and elegant",
    costumePrompt: "white-blue robe",
    stylePrompt: "cinematic",
    negativePrompt: "blurry",
    referenceAssetIds: ["ast_1", "", "ast_2"],
  });
  assert.equal(p?.appearancePrompt, "young Chinese swordswoman");
  assert.deepEqual(p?.referenceAssetIds, ["ast_1", "ast_2"]);

  assert.equal(normalizeVisualProfile({}), undefined);
  assert.equal(normalizeVisualProfile(undefined), undefined);
  assert.throws(() => normalizeVisualProfile("x"), { code: "VALIDATION" });
});

test("normalizeVisualProfile：数组字段非字符串数组抛 VALIDATION", () => {
  assert.throws(() => normalizeVisualProfile({ referenceAssetIds: "ast_1" }), { code: "VALIDATION" });
});

// ================= Prompt Anchor =================

test("deriveCharacterPromptAnchor：优先 visualProfile，顺序固定且确定性", async () => {
  const project = await seedProject();
  const character = await service.createCharacter({
    projectId: project.id,
    name: "风灵",
    description: "女主角",
    visualProfile: {
      appearancePrompt: "young Chinese swordswoman",
      identityPrompt: "sharp and elegant",
      costumePrompt: "white-blue robe",
      stylePrompt: "cinematic",
    },
  });
  const anchor = deriveCharacterPromptAnchor(character);
  assert.equal(
    anchor,
    "young Chinese swordswoman, sharp and elegant, white-blue robe, cinematic",
  );
  // 确定性：多次调用结果一致（同一角色跨镜头使用相同 Anchor）
  assert.equal(deriveCharacterPromptAnchor(character), anchor);
});

test("deriveCharacterPromptAnchor：无 visualProfile 时由结构化 appearance 兜底组装", async () => {
  const project = await seedProject();
  const character = await service.createCharacter({
    projectId: project.id,
    name: "李",
    description: "配角",
    appearance: { gender: "男", hairstyle: "短发", clothing: "黑袍" },
  });
  const anchor = deriveCharacterPromptAnchor(character);
  assert.match(anchor, /gender 男/);
  assert.match(anchor, /hairstyle 短发/);
  assert.match(anchor, /wearing 黑袍/);
});

// ================= ReferenceResolver =================

test("ReferenceResolver：无参考资产 → referenceAssets 空、useReferences false、anchor 回退", async () => {
  const project = await seedProject();
  const character = await service.createCharacter({
    projectId: project.id,
    name: "风灵",
    description: "主角",
    visualProfile: { appearancePrompt: "swordswoman" },
  });
  const resolver = new ReferenceResolver(service);
  const results = await resolver.resolve({
    projectId: project.id,
    characterIds: [character.id],
    providerId: "volcengine",
    capabilities: { supportsReferenceImages: () => true },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.anchor, "swordswoman");
  assert.equal(results[0]!.useReferences, false, "无参考资产时即使支持也回退");
  assert.equal(results[0]!.referenceAssets.length, 0);
});

test("ReferenceResolver：有参考资产 + Provider 支持 → useReferences true，注入参考", async () => {
  const project = await seedProject();
  const character = await service.createCharacter({
    projectId: project.id,
    name: "风灵",
    description: "主角",
    visualProfile: { appearancePrompt: "swordswoman" },
  });
  const refAsset = await service.createAsset({
    projectId: project.id,
    type: "reference",
    name: "风灵设定图",
    url: "https://x/ref.png",
  });
  const updated = await service.updateCharacter(character.id, {
    visualProfile: { appearancePrompt: "swordswoman", referenceAssetIds: [refAsset.id] },
  });
  const resolver = new ReferenceResolver(service);
  const results = await resolver.resolve({
    projectId: project.id,
    characterIds: [updated.id],
    providerId: "volcengine",
    capabilities: { supportsReferenceImages: () => true },
  });
  assert.equal(results[0]!.useReferences, true);
  assert.equal(results[0]!.referenceAssets[0]!.assetId, refAsset.id);
  assert.equal(results[0]!.referenceAssets[0]!.url, "https://x/ref.png");
});

test("ReferenceResolver：Provider 不支持 → useReferences false，回退 anchor（即使有参考资产）", async () => {
  const project = await seedProject();
  const character = await service.createCharacter({
    projectId: project.id,
    name: "风灵",
    description: "主角",
    visualProfile: { appearancePrompt: "swordswoman" },
  });
  const asset = await service.createAsset({
    projectId: project.id,
    type: "reference",
    name: "图",
    url: "https://x/ref.png",
  });
  await service.updateCharacter(character.id, {
    visualProfile: { appearancePrompt: "swordswoman", referenceAssetIds: [asset.id] },
  });
  const resolver = new ReferenceResolver(service);
  const results = await resolver.resolve({
    projectId: project.id,
    characterIds: [character.id],
    providerId: "dashscope",
    capabilities: { supportsReferenceImages: () => false },
  });
  assert.equal(results[0]!.useReferences, false);
  assert.equal(results[0]!.referenceAssets.length, 1, "仍解析出参考资产（可由 UI 展示）");
});

// ================= toCharacterPromptSnippets =================

test("toCharacterPromptSnippets：带稳定 anchor 映射为 Composer 片段", async () => {
  const project = await seedProject();
  const character = await service.createCharacter({
    projectId: project.id,
    name: "风灵",
    description: "女主角",
    visualProfile: { appearancePrompt: "swordswoman with white-blue robe" },
  });
  const snippets = toCharacterPromptSnippets([character]);
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0]!.name, "风灵");
  assert.equal(snippets[0]!.anchor, "swordswoman with white-blue robe");
  assert.equal(snippets[0]!.visualPrompt, "swordswoman with white-blue robe");
});

// ================= Context 投影携带 anchor =================

test("ProductionContextResolver：角色上下文携带稳定 anchor", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const character = await service.createCharacter({
    projectId: project.id,
    name: "风灵",
    description: "主角",
    visualProfile: { appearancePrompt: "swordswoman" },
  });
  const resolver = new ProductionContextResolver(service);
  const ctx = await resolver.resolve({ projectId: project.id, role: "storyboard" });
  const c = ctx.characters.find((x) => x.characterId === character.id);
  assert.ok(c);
  assert.equal(c?.anchor, "swordswoman");
  assert.equal(c?.visualPrompt, "swordswoman");
});
