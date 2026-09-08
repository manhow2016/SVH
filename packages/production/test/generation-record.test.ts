/**
 * Generation Record / Review（V0.3 Phase 5）测试。
 *
 * 覆盖：
 * 1. 创建生成记录（同 shot 版本自动递增）；
 * 2. 审核状态机：approve（approved + selected + 镜头选中资产）/ reject / replace；
 * 3. 仅完成的生成可审核（canReview 守卫）；
 * 4. 列表（按 project / shot 过滤）。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeProductionRepository } from "./helpers/fake-repository";
import { ProductionService, ProductionError } from "../src/index";

let repo: FakeProductionRepository;
let service: ProductionService;

beforeEach(() => {
  repo = new FakeProductionRepository();
  service = new ProductionService(repo);
});

async function seedShot() {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "d" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "分镜",
    duration: 6,
    shotType: "medium_shot",
  });
  const shot = await service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 3 });
  return { project, scene, storyboard, shot };
}

/** 把记录置为已完成 + 指定产出资产（测试前置，等价于真实生成完成回写） */
async function completeRecord(id: string, outputAssetId: string) {
  await repo.updateGenerationRecord(id, { status: "completed", outputAssetId });
}

test("createGenerationRecord：同 shot 内版本号从 1 递增", async () => {
  const { project, shot } = await seedShot();
  const r1 = await service.createGenerationRecord({
    projectId: project.id,
    shotId: shot.id,
    kind: "image",
    prompt: "v1",
  });
  assert.equal(r1.version, 1);
  assert.equal(r1.reviewStatus, "pending");
  assert.equal(r1.selected, false);
  const r2 = await service.createGenerationRecord({
    projectId: project.id,
    shotId: shot.id,
    kind: "image",
    prompt: "v2",
  });
  assert.equal(r2.version, 2);
  const r3 = await service.createGenerationRecord({
    projectId: project.id,
    shotId: shot.id,
    kind: "image",
    prompt: "v3",
  });
  assert.equal(r3.version, 3);
});

test("approveGeneration：仅完成的生成可审核，标记 approved+selected 并设置镜头选中资产", async () => {
  const { project, shot } = await seedShot();
  const asset = await service.createAsset({ projectId: project.id, type: "image", name: "图", url: "https://x/a.png" });
  const record = await service.createGenerationRecord({
    projectId: project.id,
    shotId: shot.id,
    kind: "image",
    prompt: "v1",
  });
  // 未完成 → 拒绝审核
  await assert.rejects(service.approveGeneration(record.id), (e: unknown) => e instanceof ProductionError && e.code === "CONFLICT");
  await completeRecord(record.id, asset.id);
  const approved = await service.approveGeneration(record.id);
  assert.equal(approved.reviewStatus, "approved");
  assert.equal(approved.selected, true);
  // 镜头选中资产被设置为产出资产
  const shotNow = await service.getShot(shot.id);
  assert.equal(shotNow.imageAssetId, asset.id);
});

test("rejectGeneration：标记 rejected，记录保留（不覆盖）", async () => {
  const { project, shot } = await seedShot();
  const asset = await service.createAsset({ projectId: project.id, type: "image", name: "图", url: "https://x/a.png" });
  const record = await service.createGenerationRecord({
    projectId: project.id,
    shotId: shot.id,
    kind: "image",
    prompt: "v1",
  });
  await completeRecord(record.id, asset.id);
  const rejected = await service.rejectGeneration(record.id);
  assert.equal(rejected.reviewStatus, "rejected");
  assert.equal(rejected.selected, false);
  assert.equal(rejected.outputAssetId, asset.id, "拒绝保留资产引用，不覆盖旧数据");
});

test("replaceGeneration：指定新资产，标记 replaced+selected，并更新镜头选中资产", async () => {
  const { project, shot } = await seedShot();
  const asset = await service.createAsset({ projectId: project.id, type: "image", name: "旧", url: "https://x/old.png" });
  const replacement = await service.createAsset({ projectId: project.id, type: "image", name: "新", url: "https://x/new.png" });
  const record = await service.createGenerationRecord({
    projectId: project.id,
    shotId: shot.id,
    kind: "image",
    prompt: "v1",
  });
  await completeRecord(record.id, asset.id);
  const replaced = await service.replaceGeneration(record.id, replacement.id);
  assert.equal(replaced.reviewStatus, "replaced");
  assert.equal(replaced.selected, true);
  assert.equal(replaced.outputAssetId, replacement.id);
  assert.equal((await service.getShot(shot.id)).imageAssetId, replacement.id);
});

test("listGenerationRecords：按 project/shot/reviewStatus 过滤", async () => {
  const { project, shot } = await seedShot();
  await service.createGenerationRecord({ projectId: project.id, shotId: shot.id, kind: "image", prompt: "a" });
  await service.createGenerationRecord({ projectId: project.id, shotId: shot.id, kind: "image", prompt: "b" });
  assert.equal((await service.listGenerationsByShot(shot.id)).length, 2);
  assert.equal((await service.listGenerationRecords(project.id, { shotId: shot.id })).length, 2);
  assert.equal((await service.listGenerationRecords(project.id, { kind: "video" })).length, 0);
  assert.equal((await service.listGenerationRecords(project.id, { reviewStatus: "pending" })).length, 2);
});

test("getProject：生成记录关联不存在的项目/镜头校验", async () => {
  const { project } = await seedShot();
  await assert.rejects(
    service.createGenerationRecord({ projectId: project.id, shotId: "sht_notexist", kind: "image", prompt: "x" }),
    (e: unknown) => e instanceof ProductionError && e.code === "NOT_FOUND",
  );
});
