/**
 * ProductionService 编排规则测试（文档 §6：跨实体约束、状态机、归属推导）。
 *
 * 使用内存仓储假实现（FakeProductionRepository）验证领域规则，
 * 不涉及真实数据库与服务器。
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

test("createProject：从 workspace 推导 userId，默认类型 short_drama", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "国风短剧" });
  assert.equal(project.userId, "usr_1");
  assert.equal(project.workspaceId, "ws_1");
  assert.equal(project.type, "short_drama");
  assert.equal(project.status, "draft");
  assert.match(project.id, /^prj_/);
});

test("createProject：工作区不存在抛 NOT_FOUND", async () => {
  await assert.rejects(
    service.createProject({ workspaceId: "ws_missing", name: "项目" }),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
});

test("createProject：非法类型抛 VALIDATION", async () => {
  repo.seedOwner("ws_1", "usr_1");
  await assert.rejects(
    service.createProject({ workspaceId: "ws_1", name: "项目", type: "movie" as never }),
    (err: unknown) => err instanceof ProductionError && err.code === "VALIDATION",
  );
});

test("updateProject：非法状态跳转抛 CONFLICT，合法跳转生效", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  await assert.rejects(
    service.updateProject(project.id, { status: "completed" }),
    (err: unknown) => err instanceof ProductionError && err.code === "CONFLICT",
  );
  const planning = await service.updateProject(project.id, { status: "planning" });
  assert.equal(planning.status, "planning");
  // 同状态 no-op
  const again = await service.updateProject(project.id, { status: "planning" });
  assert.equal(again.status, "planning");
});

test("updateProject：名称规范化生效", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const updated = await service.updateProject(project.id, { name: "  新名称  " });
  assert.equal(updated.name, "新名称");
});

test("createScript：首版 v1，approved 回退 draft，内容必需", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const script = await service.createScript({
    projectId: project.id,
    title: "第一集",
    content: "正文",
    status: "approved",
  });
  assert.equal(script.version, 1);
  assert.equal(script.status, "draft");
});

test("updateScript：内容变更版本 +1 且状态回退 draft；标题变更不升版本", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  let script = await service.createScript({ projectId: project.id, title: "第一集", content: "v1" });
  script = await service.updateScript(script.id, { status: "reviewing" });
  script = await service.updateScript(script.id, { content: "v2 内容" });
  assert.equal(script.version, 2);
  assert.equal(script.status, "draft");
  script = await service.updateScript(script.id, { title: "第一集 修改" });
  assert.equal(script.version, 2, "仅改标题不升版本");
});

test("updateScript：非法状态跳转（draft→approved）抛错", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const script = await service.createScript({ projectId: project.id, title: "第一集", content: "正文" });
  await assert.rejects(
    service.updateScript(script.id, { status: "approved" }),
    (err: unknown) => err instanceof ProductionError && err.code === "CONFLICT",
  );
});

test("createScene：剧本必须属于同一项目，order 自动递增", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const projectA = await service.createProject({ workspaceId: "ws_1", name: "项目A" });
  const projectB = await service.createProject({ workspaceId: "ws_1", name: "项目B" });
  const scriptB = await service.createScript({ projectId: projectB.id, title: "B 剧本", content: "x" });
  await assert.rejects(
    service.createScene({
      projectId: projectA.id,
      name: "场景1",
      description: "描述",
      scriptId: scriptB.id,
    }),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
  const scene1 = await service.createScene({ projectId: projectA.id, name: "场景1", description: "d" });
  const scene2 = await service.createScene({ projectId: projectA.id, name: "场景2", description: "d" });
  assert.equal(scene1.order, 0);
  assert.equal(scene2.order, 1);
});

test("createStoryboard：场景必须属于项目，时长/景别校验", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "d" });
  await assert.rejects(
    service.createStoryboard({
      projectId: project.id,
      sceneId: "scn_missing",
      description: "d",
      duration: 5,
      shotType: "medium",
    }),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "特写",
    duration: 5,
    shotType: "medium_shot",
  });
  assert.equal(storyboard.status, "draft");
  assert.equal(storyboard.order, 0);
});

test("createShot：总时长约束（分镜 5s 内最多 5s 镜头）", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "d" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "d",
    duration: 5,
    shotType: "medium_shot",
  });
  await service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 3 });
  await assert.rejects(
    service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 3 }),
    (err: unknown) => err instanceof ProductionError && err.code === "VALIDATION",
  );
});

test("updateStoryboard：缩短分镜时长低于镜头总时长被拒绝", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "d" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "d",
    duration: 10,
    shotType: "medium_shot",
  });
  await service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 6 });
  await assert.rejects(
    service.updateStoryboard(storyboard.id, { duration: 5 }),
    (err: unknown) => err instanceof ProductionError && err.code === "VALIDATION",
  );
});

test("updateShot：状态机（pending→generating→ready；pending→ready 拒绝）", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "d" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "d",
    duration: 10,
    shotType: "medium_shot",
  });
  const shot = await service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 4 });
  assert.equal(shot.status, "pending");
  await assert.rejects(
    service.updateShot(shot.id, { status: "ready" }),
    (err: unknown) => err instanceof ProductionError && err.code === "CONFLICT",
  );
  const generating = await service.updateShot(shot.id, { status: "generating" });
  assert.equal(generating.status, "generating");
  const ready = await service.updateShot(shot.id, { status: "ready" });
  assert.equal(ready.status, "ready");
});

test("createAsset：从项目推导 workspace/user，generation 校验", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const asset = await service.createAsset({
    projectId: project.id,
    type: "image",
    name: "封面",
    url: "https://cdn.example.com/a.png",
    generation: { providerId: "dashscope", modelId: "wanx", prompt: "国风" },
  });
  assert.equal(asset.workspaceId, "ws_1");
  assert.equal(asset.userId, "usr_1");
  assert.equal(asset.generation?.providerId, "dashscope");
  await assert.rejects(
    service.createAsset({
      projectId: project.id,
      type: "image",
      name: "坏 URL",
      url: "/local.png",
    }),
    (err: unknown) => err instanceof ProductionError && err.code === "VALIDATION",
  );
  await assert.rejects(
    service.createAsset({
      projectId: project.id,
      type: "image",
      name: "缺 provider",
      generation: { providerId: "" },
    }),
    (err: unknown) => err instanceof ProductionError && err.code === "VALIDATION",
  );
  assert.equal((await service.listAssets(project.id, "video")).length, 0);
  assert.equal((await service.listAssets(project.id, "image")).length, 1);
});

test("getProject：不存在抛 NOT_FOUND（隐藏细节）", async () => {
  await assert.rejects(
    service.getProject("prj_missing"),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
});

test("getProjectForWorkspace：跨工作区访问抛 NOT_FOUND（隐藏存在性）", async () => {
  repo.seedOwner("ws_1", "usr_1");
  repo.seedOwner("ws_2", "usr_2");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  assert.equal((await service.getProjectForWorkspace(project.id, "ws_1")).id, project.id);
  await assert.rejects(
    service.getProjectForWorkspace(project.id, "ws_2"),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
  await assert.rejects(
    service.getProjectForWorkspace("prj_missing", "ws_1"),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
});

// ================= 删除与资产编辑（V0.3 制作中心完善） =================

test("deleteScript：删除成功，重复删除抛 NOT_FOUND", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const script = await service.createScript({ projectId: project.id, title: "剧本", content: "内容" });
  await service.deleteScript(script.id);
  assert.equal((await service.listScripts(project.id)).length, 0);
  await assert.rejects(
    service.deleteScript(script.id),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
});

test("deleteCharacter：删除成功，越权/不存在抛 NOT_FOUND", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const character = await service.createCharacter({ projectId: project.id, name: "主角", description: "描述" });
  await service.deleteCharacter(character.id);
  assert.equal((await service.listCharacters(project.id)).length, 0);
  await assert.rejects(
    service.deleteCharacter(character.id),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
});

test("deleteScene：级联清掉其分镜与镜头", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "描述" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "分镜",
    duration: 5,
    shotType: "medium_shot",
  });
  await service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 3 });
  await service.deleteScene(scene.id);
  assert.equal((await service.listScenes(project.id)).length, 0);
  assert.equal((await service.listStoryboards(project.id)).length, 0);
  assert.equal((await service.listShots(project.id)).length, 0);
});

test("deleteStoryboard：级联清掉其镜头", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "描述" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "分镜",
    duration: 5,
    shotType: "medium_shot",
  });
  await service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 3 });
  await service.deleteStoryboard(storyboard.id);
  assert.equal((await service.listStoryboards(project.id)).length, 0);
  assert.equal((await service.listShots(project.id)).length, 0);
});

test("deleteShot：删除成功，不存在抛 NOT_FOUND", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const scene = await service.createScene({ projectId: project.id, name: "场景", description: "描述" });
  const storyboard = await service.createStoryboard({
    projectId: project.id,
    sceneId: scene.id,
    description: "分镜",
    duration: 5,
    shotType: "medium_shot",
  });
  const shot = await service.createShot({ projectId: project.id, storyboardId: storyboard.id, duration: 3 });
  await service.deleteShot(shot.id);
  assert.equal((await service.listShots(project.id)).length, 0);
  await assert.rejects(
    service.deleteShot(shot.id),
    (err: unknown) => err instanceof ProductionError && err.code === "NOT_FOUND",
  );
});

test("updateAsset：编辑名称/类型/URL 生效，非法类型抛 VALIDATION", async () => {
  repo.seedOwner("ws_1", "usr_1");
  const project = await service.createProject({ workspaceId: "ws_1", name: "项目" });
  const asset = await service.createAsset({ projectId: project.id, type: "image", name: "旧名", url: "https://a.com/1.png" });
  const updated = await service.updateAsset(asset.id, { name: "新名", type: "video", url: "https://a.com/v.mp4" });
  assert.equal(updated.name, "新名");
  assert.equal(updated.type, "video");
  assert.equal(updated.url, "https://a.com/v.mp4");
  await assert.rejects(
    service.updateAsset(asset.id, { type: "movie" as never }),
    (err: unknown) => err instanceof ProductionError && err.code === "VALIDATION",
  );
});
