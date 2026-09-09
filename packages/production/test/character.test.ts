/**
 * Character 领域规则测试（文档 §6.3）。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAppearance,
  normalizeOptionalText,
  ProductionError,
  ProductionService,
  validateCharacterDescription,
  validateCharacterName,
} from "../src/index";
import { FakeProductionRepository } from "./helpers/fake-repository";

let repo: FakeProductionRepository;
let service: ProductionService;

beforeEach(() => {
  repo = new FakeProductionRepository();
  service = new ProductionService(repo);
});

/** 建项目 + 角色（voiceAssetId 用例的基础设施） */
async function seedCharacter() {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const character = await service.createCharacter({
    projectId: project.id,
    name: "林墨",
    description: "主角",
  });
  return { project, character };
}

test("validateCharacterName / validateCharacterDescription", () => {
  assert.equal(validateCharacterName(" 林墨 "), "林墨");
  assert.throws(() => validateCharacterName(""), /不能为空/);
  assert.throws(() => validateCharacterName(null), /必须为字符串/);
  assert.equal(validateCharacterDescription("主角"), "主角");
  assert.throws(() => validateCharacterDescription("  "), /不能为空/);
});

test("normalizeAppearance：白名单字段、字符串值、截断", () => {
  const appearance = normalizeAppearance({
    gender: "女",
    age: "20",
    hairstyle: "长发",
    unknown: "ignored",
  });
  assert.equal(appearance.gender, "女");
  assert.equal("unknown" in appearance, false, "白名单外的字段不保留");
  assert.equal(appearance.age, "20");
  assert.deepEqual(normalizeAppearance(undefined), {});
  assert.deepEqual(normalizeAppearance({ hairstyle: "  " }), {});
  assert.throws(() => normalizeAppearance({ clothing: 123 }), /字符串/);
  assert.throws(() => normalizeAppearance("not-an-object"), /必须为对象/);
});

test("normalizeOptionalText：空串转 undefined，限长", () => {
  assert.equal(normalizeOptionalText(" 傲娇 ", "personality"), "傲娇");
  assert.equal(normalizeOptionalText("  ", "personality"), undefined);
  assert.equal(normalizeOptionalText(undefined, "personality"), undefined);
  assert.throws(() => normalizeOptionalText(123, "personality"), /必须为字符串/);
  assert.equal(normalizeOptionalText("a".repeat(600), "personality")?.length, 500);
});

// ================= updateCharacter：voiceAssetId（配音音色资产引用） =================

test("updateCharacter：voiceAssetId 跨项目资产被拒（VALIDATION）且不写回", async () => {
  const { character } = await seedCharacter();
  const projectB = await service.createProject({ workspaceId: "ws_1", name: "项目B" });
  const foreignAudio = await service.createAsset({
    projectId: projectB.id,
    type: "audio",
    name: "B 项目音色",
    url: "https://x/b.wav",
  });
  await assert.rejects(
    service.updateCharacter(character.id, { voiceAssetId: foreignAudio.id }),
    /音色资产不合法：必须属于该项目且类型为音频/,
  );
  assert.equal((await service.getCharacter(character.id)).voiceAssetId, undefined, "拒绝后不写回");
});

test("updateCharacter：voiceAssetId 非音频类型被拒（VALIDATION）", async () => {
  const { project, character } = await seedCharacter();
  const image = await service.createAsset({
    projectId: project.id,
    type: "image",
    name: "参考图",
    url: "https://x/a.png",
  });
  await assert.rejects(
    service.updateCharacter(character.id, { voiceAssetId: image.id }),
    /音色资产不合法：必须属于该项目且类型为音频/,
  );
});

test("updateCharacter：voiceAssetId 资产不存在抛 NOT_FOUND", async () => {
  const { character } = await seedCharacter();
  await assert.rejects(
    service.updateCharacter(character.id, { voiceAssetId: "ast_missing" }),
    (e: unknown) => e instanceof ProductionError && e.code === "NOT_FOUND",
  );
});

test("updateCharacter：同项目 audio 资产写回 voiceAssetId", async () => {
  const { project, character } = await seedCharacter();
  const audio = await service.createAsset({
    projectId: project.id,
    type: "audio",
    name: "音色",
    url: "https://x/v.wav",
  });
  const updated = await service.updateCharacter(character.id, { voiceAssetId: `  ${audio.id}  ` });
  assert.equal(updated.voiceAssetId, audio.id);
  assert.equal((await service.getCharacter(character.id)).voiceAssetId, audio.id);
});

test("updateCharacter：voiceAssetId 空串清空（置 undefined）", async () => {
  const { project, character } = await seedCharacter();
  const audio = await service.createAsset({
    projectId: project.id,
    type: "audio",
    name: "音色",
    url: "https://x/v.wav",
  });
  await service.updateCharacter(character.id, { voiceAssetId: audio.id });
  assert.equal((await service.getCharacter(character.id)).voiceAssetId, audio.id, "先写入音色");
  const cleared = await service.updateCharacter(character.id, { voiceAssetId: "" });
  assert.equal(cleared.voiceAssetId, undefined);
  assert.equal((await service.getCharacter(character.id)).voiceAssetId, undefined);
});
