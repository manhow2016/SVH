/**
 * Prompt Composer（V0.3 Phase 2）测试。
 *
 * 验证：
 * 1. 段落组合（style/scene/characters/shot/camera/action/raw）；
 * 2. negative 组合与去重；
 * 3. metadata 记录来源（模板/项目/镜头/角色/供应商）。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DefaultPromptComposer } from "../src/index";

let composer: DefaultPromptComposer;

beforeEach(() => {
  composer = new DefaultPromptComposer();
});

test("composeImage：无上下文仅原始描述 → 输出即为原始描述", () => {
  const out = composer.composeImage({ rawPrompt: "雨夜的霓虹街头" });
  assert.equal(out.prompt, "雨夜的霓虹街头");
  assert.equal(out.metadata.templateId, "default");
});

test("composeImage：项目风格 + 原始描述按顺序组合", () => {
  const out = composer.composeImage({
    rawPrompt: "女侠立于飞檐之上",
    projectStyle: "Chinese fantasy cinematic, moonlit",
  });
  assert.equal(out.prompt, "Chinese fantasy cinematic, moonlit, 女侠立于飞檐之上");
});

test("composeImage：场景 + 角色 + 镜头 + 相机 全量组合", () => {
  const out = composer.composeImage({
    rawPrompt: "挥剑",
    projectStyle: "cinematic",
    scene: { description: "皇宫飞檐", location: "夜空下", time: "夜晚" },
    characters: [{ name: "风灵", anchor: "young Chinese swordswoman, white-blue robe, long black hair" }],
    shot: { description: "女侠挥剑特写", framing: "medium close-up", cameraMovement: "slow push-in" },
  });
  assert.match(out.prompt, /^cinematic, /);
  assert.match(out.prompt, /皇宫飞檐, in 夜空下, at 夜晚/);
  assert.match(out.prompt, /young Chinese swordswoman, white-blue robe, long black hair/);
  assert.match(out.prompt, /女侠挥剑特写 \(medium close-up\)/);
  assert.match(out.prompt, /slow push-in/);
  assert.ok(out.prompt.endsWith("挥剑"), "raw 描述放最后");
});

test("composeVideo：动作/相机优先使用 actionPrompt 与镜头 cameraMovement", () => {
  const out = composer.composeVideo({
    rawPrompt: "竹林追逐",
    projectStyle: "wuxia",
    shot: { action: "奔跑", cameraMovement: "tracking shot" },
    actionPrompt: "快速横移",
  });
  assert.match(out.prompt, /wuxia, /);
  assert.match(out.prompt, /快速横移/, "显式 actionPrompt 优先于镜头 action");
  assert.ok(out.prompt.includes("跟踪") || out.prompt.includes("tracking shot"));
});

test("negative：全局负面 + 调用方负面 + 风格负面，去重", () => {
  const out = composer.composeImage({
    rawPrompt: "图",
    projectStyle: "cinematic",
    negativePrompt: "blurry, 文字水印",
  });
  assert.ok(out.negativePrompt);
  // 全局含 blurry，调用方又给 blurry → 去重只出现一次
  const count = (out.negativePrompt!.match(/blurry/g) ?? []).length;
  assert.equal(count, 1);
  assert.match(out.negativePrompt!, /low quality/);
  assert.match(out.negativePrompt!, /文字水印/);
  assert.match(out.negativePrompt!, /cinematic/, "风格也进入 negative 池");
});

test("metadata：记录模板/项目/镜头/场景/角色/供应商", () => {
  const out = composer.composeImage({
    rawPrompt: "图",
    projectId: "prj_1",
    shotId: "sht_1",
    sceneId: "scn_1",
    characterIds: ["chr_1", "chr_2"],
    providerId: "volcengine",
  });
  assert.equal(out.metadata.projectId, "prj_1");
  assert.equal(out.metadata.shotId, "sht_1");
  assert.equal(out.metadata.sceneId, "scn_1");
  assert.deepEqual(out.metadata.characterIds, ["chr_1", "chr_2"]);
  assert.equal(out.metadata.providerId, "volcengine");
});
