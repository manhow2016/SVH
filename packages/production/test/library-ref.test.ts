/**
 * 资产库引用测试（我的资产 → 项目资产）：
 * createAsset 携带 assetLibPath 时写入引用行 + metadata.libraryPath；
 * listAssetLibraryRefsByFolder 按文件夹前缀返回引用视图（含项目/资产名）。
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

async function seedProject() {
  repo.seedOwner("ws_1", "usr_1");
  return service.createProject({ workspaceId: "ws_1", name: "国风短剧" });
}

test("createAsset 携带 assetLibPath：写入引用并落 metadata.libraryPath", async () => {
  const project = await seedProject();
  const asset = await service.createAsset({
    projectId: project.id,
    type: "image",
    name: "主角",
    assetLibPath: "电影/角色/主角.png",
  });
  assert.equal(asset.metadata?.libraryPath, "电影/角色/主角.png");

  const refs = await repo.listAssetLibraryRefsByFolder("电影");
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.libPath, "电影/角色/主角.png");
  assert.equal(refs[0]!.assetId, asset.id);
  assert.equal(refs[0]!.projectId, project.id);
  assert.equal(refs[0]!.projectName, "国风短剧");
  assert.equal(refs[0]!.assetName, "主角");
});

test("listAssetLibraryRefsByFolder：仅匹配目标文件夹前缀，忽略其他文件夹", async () => {
  const project = await seedProject();
  await service.createAsset({
    projectId: project.id, type: "image", name: "a", assetLibPath: "电影/角色/a.png",
  });
  await service.createAsset({
    projectId: project.id, type: "image", name: "b", assetLibPath: "动画/场景/b.png",
  });
  assert.equal((await repo.listAssetLibraryRefsByFolder("电影")).length, 1);
  assert.equal((await repo.listAssetLibraryRefsByFolder("动画")).length, 1);
  assert.equal((await repo.listAssetLibraryRefsByFolder("不存在")).length, 0);
});

test("assetLibPath 非法路径（.. 逃逸 / 绝对路径）抛 VALIDATION", async () => {
  const project = await seedProject();
  for (const bad of ["../角色/a.png", "/绝对/路径.png", "a\\b.png"]) {
    await assert.rejects(
      service.createAsset({ projectId: project.id, type: "image", name: "x", assetLibPath: bad }),
      (err: unknown) => err instanceof ProductionError && err.code === "VALIDATION",
    );
  }
});
