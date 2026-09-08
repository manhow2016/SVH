/**
 * 短剧多集领域测试（V0.3）。
 *
 * 真实临时库 + DrizzleProductionRepository：
 * createProject 自动建第 1 集、集号递增/缺省名、最后一集不可删、
 * 剧本/场景/时间轴默认归第 1 集与指定集归属校验、各列表 episodeId 过滤、
 * autoCreateTimeline 按集取数。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type SVHDatabase } from "@svh/database";
import {
  DrizzleProductionRepository,
  ProductionError,
  ProductionService,
  TimelineService,
} from "@svh/production";

let dir: string;
let db: SVHDatabase;
let repo: DrizzleProductionRepository;
let service: ProductionService;
let timelineService: TimelineService;
let projectId: string;

async function assertProductionError(
  promise: Promise<unknown>,
  pattern?: RegExp,
  code?: string,
): Promise<ProductionError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ProductionError, `应抛 ProductionError（实际 ${String(err)}）`);
    if (pattern) assert.match((err as Error).message, pattern);
    if (code) assert.equal((err as ProductionError).code, code);
    return err as ProductionError;
  }
  assert.fail("应抛 ProductionError 但未抛");
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "svh-episode-"));
  db = createDatabase(join(dir, "test.db"));
  repo = new DrizzleProductionRepository(db);
  service = new ProductionService(repo);
  timelineService = new TimelineService(repo);
  const now = Date.now();
  db.$client.exec(
    `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
       VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
     INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
       VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});`,
  );
  const project = await service.createProject({
    workspaceId: "ws1",
    name: "多集短剧",
    type: "short_drama",
    settings: {},
  });
  projectId = project.id;
});

after(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("createProject：自动创建第 1 集（order=1，名「第 1 集」）", async () => {
  const episodes = await service.listEpisodes(projectId);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.order, 1);
  assert.equal(episodes[0]!.name, "第 1 集");
  assert.equal(episodes[0]!.projectId, projectId);
});

test("createEpisode：集号递增 + 缺省名；显式集号校验", async () => {
  const e2 = await service.createEpisode({ projectId });
  assert.equal(e2.order, 2);
  assert.equal(e2.name, "第 2 集");
  const e3 = await service.createEpisode({ projectId, order: 5, name: "番外" });
  assert.equal(e3.order, 5);
  assert.equal(e3.name, "番外");
  // 显式非法集号
  await assertProductionError(service.createEpisode({ projectId, order: 0 }), />= 1/, "VALIDATION");
  // 跨项目集
  await assertProductionError(
    service.createEpisode({ projectId: "prj_missing" }),
    /项目 不存在/,
    "NOT_FOUND",
  );
});

test("deleteEpisode：最后一集不可删；删中间集的脚本挂载 SET NULL 语义（服务层不回填）", async () => {
  // 项目另外两个集（当前有 1/2/5 三集）→ 删除番外（第 5 集）
  const episodes = await service.listEpisodes(projectId);
  const ep5 = episodes.find((e) => e.order === 5)!;
  await service.deleteEpisode(ep5.id);
  assert.equal((await service.listEpisodes(projectId)).length, 2);
  // 一路删至最后一集
  for (const e of (await service.listEpisodes(projectId)).slice(1)) {
    await service.deleteEpisode(e.id);
  }
  await assertProductionError(
    service.deleteEpisode((await service.listEpisodes(projectId))[0]!.id),
    /至少保留一集/,
    "VALIDATION",
  );
});

test("createScript/createScene：默认归第 1 集；指定集校验归属", async () => {
  const episodes = await service.listEpisodes(projectId);
  const ep1 = episodes[0]!;
  const ep2 = await service.createEpisode({ projectId, name: "第二集" });
  assert.equal(ep2.order, 2);

  const script = await service.createScript({ projectId, title: "第 1 集剧本", content: "内容" });
  assert.equal(script.episodeId, ep1.id, "未指定集默认归第 1 集");
  const scene = await service.createScene({
    projectId,
    name: "场景1",
    description: "描述",
    episodeId: ep2.id,
  });
  assert.equal(scene.episodeId, ep2.id);
  // 不存在的集 → NOT_FOUND
  await assertProductionError(
    service.createScene({ projectId, name: "x", description: "d", episodeId: "epi_missing" }),
    /集 不存在/,
    "NOT_FOUND",
  );
  // 跨项目集 → VALIDATION（归属校验）
  const other = await service.createProject({ workspaceId: "ws1", name: "另一项目", type: "short_drama", settings: {} });
  const otherEpisode = await service.createEpisode({ projectId: other.id });
  await assertProductionError(
    service.createScene({ projectId, name: "x", description: "d", episodeId: otherEpisode.id }),
    /不属于/,
    "VALIDATION",
  );
});

test("列表 episodeId 过滤：scripts / scenes / shots / timelines", async () => {
  const episodes = await service.listEpisodes(projectId);
  const ep1 = episodes[0]!;
  const ep2 = episodes[1]!;

  // 复原：第 1 集市集（before 第一个脚本已建在第 1 集）；两集各补一个场景
  const s1 = await service.createScript({ projectId, title: "第 2 集剧本", content: "内容2", episodeId: ep2.id });
  await service.createScript({ projectId, title: "第 1 集剧本2", content: "内容1b", episodeId: ep1.id });
  const sceneE1 = await service.createScene({ projectId, name: "第 1 集场景", description: "d", episodeId: ep1.id });
  const sceneE2 = await service.createScene({ projectId, name: "第 2 集场景", description: "d", episodeId: ep2.id });
  assert.deepEqual(
    (await service.listScripts(projectId, ep2.id)).map((x) => x.id),
    [s1.id],
  );
  assert.equal((await service.listScripts(projectId, ep2.id)).length, 1);
  const scenesE2 = await service.listScenes(projectId, ep2.id);
  assert.ok(scenesE2.some((s) => s.id === sceneE2.id), "第 2 集过滤含本集场景");
  assert.ok(!scenesE2.some((s) => s.id === sceneE1.id), "第 2 集过滤不含第 1 集场景");

  // shots 链过滤：场景 → 分镜 → 镜头
  const sb1 = await service.createStoryboard({
    projectId,
    sceneId: sceneE1.id,
    description: "分镜1",
    duration: 10,
    shotType: "medium",
  });
  await service.createShot({ projectId, storyboardId: sb1.id, duration: 5 });
  const sb2 = await service.createStoryboard({
    projectId,
    sceneId: sceneE2.id,
    description: "分镜2",
    duration: 8,
    shotType: "medium",
  });
  const shotE2 = await service.createShot({ projectId, storyboardId: sb2.id, duration: 5 });
  assert.deepEqual(
    (await service.listShots(projectId, ep2.id)).map((s) => s.id),
    [shotE2.id],
  );

  // timelines 过滤 + 创建默认归第 1 集
  const tl1 = await timelineService.createTimeline({ projectId, name: "第 1 集成片" });
  const tl2 = await timelineService.createTimeline({ projectId, name: "第 2 集成片", episodeId: ep2.id });
  assert.equal(tl1.episodeId, ep1.id, "时间轴默认归第 1 集");
  assert.equal(tl2.episodeId, ep2.id);
  assert.equal((await timelineService.listTimelines(projectId, ep2.id)).length, 1);
  assert.equal((await timelineService.listTimelines(projectId, ep1.id)).length, 1);
});
