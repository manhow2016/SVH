/**
 * Generation Plan（V0.3 Phase 6）测试。
 *
 * 覆盖：
 * 1. 每镜头生成 image 项；已有首帧图追加依赖 image 的 video 项；
 * 2. 优先级 = 镜头 order，按 order 排序；
 * 3. includeVideo=false 不产生 video 项；scope/projectId 透传。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGenerationPlan, planItemId } from "../src/index";
import type { ProductionShot } from "../src/index";

function shot(partial: Partial<ProductionShot> & { id: string }): ProductionShot {
  return {
    projectId: "prj_1",
    storyboardId: "sto_1",
    order: 0,
    duration: 3,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

test("buildGenerationPlan：每镜头 image 项，有首帧图则追加依赖 image 的 video 项", () => {
  const shots: ProductionShot[] = [
    shot({ id: "sht_1", order: 0 }),
    shot({ id: "sht_2", order: 1, imageAssetId: "ast_img" }),
  ];
  const plan = buildGenerationPlan("prj_1", shots);
  assert.equal(plan.projectId, "prj_1");
  assert.equal(plan.items.length, 3);
  // sht_1 只有 image
  const s1Img = plan.items.find((i) => i.id === planItemId("sht_1", "image"));
  assert.ok(s1Img);
  assert.equal(s1Img!.type, "image");
  assert.equal(s1Img!.dependencies.length, 0);
  // sht_2 有 image + video（依赖 image）
  const s2Img = plan.items.find((i) => i.id === planItemId("sht_2", "image"));
  const s2Vid = plan.items.find((i) => i.id === planItemId("sht_2", "video"));
  assert.ok(s2Img);
  assert.ok(s2Vid);
  assert.equal(s2Vid!.type, "video");
  assert.deepEqual(s2Vid!.dependencies, [planItemId("sht_2", "image")]);
});

test("优先级 = 镜头 order；按 order 排序", () => {
  const shots: ProductionShot[] = [
    shot({ id: "sht_b", order: 2 }),
    shot({ id: "sht_a", order: 1 }),
    shot({ id: "sht_c", order: 0 }),
  ];
  const plan = buildGenerationPlan("prj_1", shots);
  const priorities = plan.items.map((i) => i.priority);
  assert.deepEqual(priorities, [0, 1, 2]);
  assert.equal(plan.items[0]!.shotId, "sht_c");
});

test("includeVideo=false 不产生 video 项，scope 透传", () => {
  const shots: ProductionShot[] = [shot({ id: "sht_1", imageAssetId: "ast_img" })];
  const plan = buildGenerationPlan("prj_1", shots, { storyboardId: "sto_1" }, { includeVideo: false });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0]!.type, "image");
  assert.deepEqual(plan.scope, { storyboardId: "sto_1" });
});
