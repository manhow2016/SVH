/**
 * Character 领域规则测试（文档 §6.3）。
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type SVHDatabase } from "@svh/database";
import {
  DrizzleProductionRepository,
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

// ================= 真实 drizzle 仓储持久化：voiceAssetId 清空（null 语义） =================

describe("updateCharacter：voiceAssetId 清空（真实临时库 + DrizzleProductionRepository）", () => {
  let dir: string;
  let db: SVHDatabase;
  let svc: ProductionService;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "svh-character-voice-"));
    db = createDatabase(join(dir, "test.db"));
    svc = new ProductionService(new DrizzleProductionRepository(db));
    const now = Date.now();
    db.$client.exec(
      `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
         VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
       INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
         VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});`,
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("voiceAssetId：null / 空串清空后 getCharacter().voiceAssetId === undefined（真实落库）", async () => {
    const project = await svc.createProject({ workspaceId: "ws1", name: "项目" });
    const character = await svc.createCharacter({ projectId: project.id, name: "林墨", description: "主角" });
    const audio = await svc.createAsset({
      projectId: project.id,
      type: "audio",
      name: "音色",
      url: "https://x/v.wav",
    });
    // 先写入，再分别用 null / 空串清空；每次清空后都走真实 getCharacter（drizzle 读库）验证
    await svc.updateCharacter(character.id, { voiceAssetId: audio.id });
    assert.equal((await svc.getCharacter(character.id)).voiceAssetId, audio.id, "写入生效");
    await svc.updateCharacter(character.id, { voiceAssetId: null });
    assert.equal((await svc.getCharacter(character.id)).voiceAssetId, undefined, "null 清空后应为 undefined");
    await svc.updateCharacter(character.id, { voiceAssetId: audio.id });
    assert.equal((await svc.getCharacter(character.id)).voiceAssetId, audio.id, "清空后再次写入生效");
    await svc.updateCharacter(character.id, { voiceAssetId: "  " });
    assert.equal((await svc.getCharacter(character.id)).voiceAssetId, undefined, "空串清空后应为 undefined");
  });
});

// ================= 形象方案：listCharacterSchemes / deleteCharacterSchemes（真实 drizzle 仓储） =================

describe("listCharacterSchemes / deleteCharacterSchemes（真实临时库 + DrizzleProductionRepository）", () => {
  let dir: string;
  let db: SVHDatabase;
  let svc: ProductionService;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "svh-character-scheme-"));
    db = createDatabase(join(dir, "test.db"));
    svc = new ProductionService(new DrizzleProductionRepository(db));
    const now = Date.now();
    db.$client.exec(
      `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
         VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
       INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
         VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});`,
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 方案元数据打标（与 worker/server 契约字面量一致：svhRole/characterId/batchId/seq） */
  function schemeMeta(characterId: string, batchId: string, seq: number) {
    return { svhRole: "character_scheme", characterId, batchId, seq };
  }

  /**
   * 直接 SQL 改写 created_at：真实库毫秒级时间戳可能平票，
   * 显式写入两批不同值，保证「最新批」的选取确定可复现。
   */
  function setCreatedAt(assetId: string, ts: number): void {
    db.$client.prepare("UPDATE production_assets SET created_at = ? WHERE id = ?").run(ts, assetId);
  }

  async function createSchemeImage(projectId: string, name: string, metadata: Record<string, unknown>) {
    return svc.createAsset({ projectId, type: "image", name, url: `https://x/${name}.png`, metadata });
  }

  test("listCharacterSchemes：跨批分组取最新批、批内按 seq 排序；deleteCharacterSchemes 清理全部批次", async () => {
    const project = await svc.createProject({ workspaceId: "ws1", name: "项目" });
    const ch1 = await svc.createCharacter({ projectId: project.id, name: "林墨", description: "主角" });
    const ch2 = await svc.createCharacter({ projectId: project.id, name: "苏棠", description: "配角" });

    // 无方案：batchId null / schemes 空
    assert.deepEqual(await svc.listCharacterSchemes(project.id, ch1.id), { batchId: null, schemes: [] });

    // 批 A（旧）：A1(seq1)/A2(seq2)；批 B（更新）：B2(seq2)/B1(seq1)，B2 先建（验证按 seq 而非创建序）
    const a1 = await createSchemeImage(project.id, "A1", schemeMeta(ch1.id, "batch_a", 1));
    const a2 = await createSchemeImage(project.id, "A2", schemeMeta(ch1.id, "batch_a", 2));
    const b2 = await createSchemeImage(project.id, "B2", schemeMeta(ch1.id, "batch_b", 2));
    const b1 = await createSchemeImage(project.id, "B1", schemeMeta(ch1.id, "batch_b", 1));
    // 干扰项：他角色方案图 + 未打标普通图（均不应计入）
    const c2 = await createSchemeImage(project.id, "C2", schemeMeta(ch2.id, "batch_x", 1));
    const plain = await svc.createAsset({
      projectId: project.id,
      type: "image",
      name: "普通图",
      url: "https://x/plain.png",
    });
    // 批 B 的 created_at 固定晚于批 A（显式 SQL 改写，避免真实时间戳平票）
    const base = Date.now();
    setCreatedAt(a1.id, base);
    setCreatedAt(a2.id, base);
    setCreatedAt(b1.id, base + 1000);
    setCreatedAt(b2.id, base + 1000);

    const hit = await svc.listCharacterSchemes(project.id, ch1.id);
    assert.equal(hit.batchId, "batch_b", "应取 created_at 最大的批 batch_b");
    assert.deepEqual(hit.schemes.map((s) => s.id), [b1.id, b2.id], "批内按 seq 升序（1 前 2 后）");

    // 删除：跨批全部清理，他角色/普通图不受影响
    await svc.deleteCharacterSchemes(ch1.id);
    assert.deepEqual(
      await svc.listCharacterSchemes(project.id, ch1.id),
      { batchId: null, schemes: [] },
      "cleanup 后无方案",
    );
    const remain = await svc.listAssets(project.id, "image");
    assert.deepEqual(
      remain.map((a) => a.id).sort(),
      [c2.id, plain.id].sort(),
      "仅 ch1 的方案资产被删（跨批）",
    );
  });

  test("deleteCharacterSchemes：角色不存在抛 NOT_FOUND", async () => {
    await assert.rejects(
      svc.deleteCharacterSchemes("chr_missing"),
      (e: unknown) => e instanceof ProductionError && e.code === "NOT_FOUND",
    );
  });

  test("deleteCharacterSchemes：无方案角色静默成功", async () => {
    const project = await svc.createProject({ workspaceId: "ws1", name: "项目2" });
    const ch = await svc.createCharacter({ projectId: project.id, name: "周野", description: "无方案" });
    await svc.deleteCharacterSchemes(ch.id);
    assert.deepEqual(await svc.listCharacterSchemes(project.id, ch.id), { batchId: null, schemes: [] });
  });
});
