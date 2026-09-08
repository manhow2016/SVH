/**
 * Auto Timeline 领域规则测试（V0.3 文档 Phase 5）。
 *
 * 覆盖：层级排序确定性、素材裁决回退链（选中 → 最新 ready → none）、
 * 计划生成（startTime 累计 / duration / skipped）与空项目边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoTimelinePlan,
  orderProjectShots,
  selectShotVideoAsset,
  type GenerationRecord,
  type ProductionShot,
} from "../src/index";

const rec = (
  id: string,
  over: Partial<GenerationRecord> = {},
): GenerationRecord =>
  ({
    id,
    projectId: "p1",
    shotId: "s1",
    kind: "video",
    version: 1,
    prompt: "p",
    status: "completed",
    reviewStatus: "generated",
    selected: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as GenerationRecord;

const shot = (id: string, over: Partial<ProductionShot> = {}): ProductionShot =>
  ({
    id,
    projectId: "p1",
    storyboardId: "sb1",
    order: 0,
    duration: 5,
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as ProductionShot;

// ---- 排序 ----

test("orderProjectShots：按 scene → storyboard → shot 三级 order 升序（输入乱序不变）", () => {
  const scenes = [
    { id: "sc2", order: 1 },
    { id: "sc1", order: 0 },
  ];
  const storyboards = [
    { id: "sb2", sceneId: "sc1", order: 1 },
    { id: "sb1", sceneId: "sc1", order: 0 },
    { id: "sb3", sceneId: "sc2", order: 0 },
  ];
  const shots = [
    shot("s3", { storyboardId: "sb2", order: 0 }),
    shot("s1", { storyboardId: "sb1", order: 1 }),
    shot("s2", { storyboardId: "sb1", order: 0 }),
    shot("s4", { storyboardId: "sb3", order: 0 }),
  ];
  const out = orderProjectShots(scenes, storyboards, shots).map((s) => s.id);
  assert.deepEqual(out, ["s2", "s1", "s3", "s4"]);
});

test("orderProjectShots：父级缺失时排到该组之后，shot.id 兜底保证确定序", () => {
  const shots = [
    shot("b", { storyboardId: "ghost", order: 0 }),
    shot("a", { storyboardId: "sb1", order: 0 }),
    shot("c", { storyboardId: "sb1", order: 0 }),
  ];
  const out = orderProjectShots([{ id: "sc1", order: 0 }], [{ id: "sb1", sceneId: "sc1", order: 0 }], shots).map(
    (s) => s.id,
  );
  assert.deepEqual(out, ["a", "c", "b"]);
});

// ---- 素材裁决 ----

test("selectShotVideoAsset：优先 shot.videoAssetId（可用）", () => {
  const sel = selectShotVideoAsset(shot("s1", { videoAssetId: "v1" }), [rec("r1", { outputAssetId: "v2" })]);
  assert.deepEqual(sel, { shotId: "s1", assetId: "v1", source: "shot-selected" });
});

test("selectShotVideoAsset：选中资产失效 → 回退最新完成生成记录（version 最大）", () => {
  const sel = selectShotVideoAsset(
    shot("s1", { videoAssetId: "v0" }),
    [
      rec("r1", { version: 1, outputAssetId: "v1" }),
      rec("r2", { version: 3, outputAssetId: "v2" }),
      rec("r3", { version: 2, outputAssetId: "v0" }), // 不可用
    ],
    (id) => id !== "v0",
  );
  assert.deepEqual(sel, { shotId: "s1", assetId: "v2", source: "latest-ready" });
});

test("selectShotVideoAsset：非 video / 非 completed / 无 output 的记录都不参与", () => {
  const sel = selectShotVideoAsset(shot("s1"), [
    rec("r1", { kind: "image", status: "completed", outputAssetId: "v1" }),
    rec("r2", { kind: "video", status: "failed", outputAssetId: "v2" }),
    rec("r3", { kind: "video", status: "completed" }),
    rec("r4", { kind: "video", status: "completed", outputAssetId: "v9" }),
  ]);
  assert.equal(sel.source, "latest-ready");
  assert.equal(sel.assetId, "v9");
});

test("selectShotVideoAsset：同 version 按 id 字典序稳定", () => {
  const sel = selectShotVideoAsset(shot("s1"), [
    rec("rb", { version: 2, outputAssetId: "vb" }),
    rec("ra", { version: 2, outputAssetId: "va" }),
    rec("rc", { version: 2, outputAssetId: "vc" }),
    rec("rd", { version: 1, outputAssetId: "vd" }),
  ]);
  assert.equal(sel.assetId, "va");
  assert.equal(sel.source, "latest-ready");
});

test("selectShotVideoAsset：无任何候选 → none + 原因", () => {
  const sel = selectShotVideoAsset(shot("s1"), [], () => true);
  assert.equal(sel.source, "none");
  assert.equal(sel.assetId, undefined);
  assert.match(sel.reason ?? "", /没有已就绪/);
});

// ---- 计划 ----

test("buildAutoTimelinePlan：按序累计 startTime，duration = 镜头时长，缺失素材跳过", () => {
  const scenes = [{ id: "sc1", order: 0 }];
  const storyboards = [{ id: "sb1", sceneId: "sc1", order: 0 }];
  const shots = [
    shot("s1", { order: 0, duration: 5, videoAssetId: "v1" }),
    shot("s2", { order: 1, duration: 3 }), // 无素材 → 跳过
    shot("s3", { order: 2, duration: 8, videoAssetId: "v3" }),
  ];
  const plan = buildAutoTimelinePlan({ scenes, storyboards, shots });
  assert.equal(plan.clips.length, 2);
  assert.deepEqual(
    plan.clips.map((c) => [c.shotId, c.startTime, c.duration, c.order]),
    [
      ["s1", 0, 5, 0],
      ["s3", 5, 8, 1],
    ],
  );
  assert.equal(plan.duration, 13);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]!.shotId, "s2");
});

test("buildAutoTimelinePlan：生成记录回退 + usableAssetIds 过滤", () => {
  const plan = buildAutoTimelinePlan({
    scenes: [{ id: "sc1", order: 0 }],
    storyboards: [{ id: "sb1", sceneId: "sc1", order: 0 }],
    shots: [
      shot("s1", { duration: 4 }),
      shot("s2", { duration: 6, videoAssetId: "vB" }), // vB 不可用 → 回退记录
    ],
    recordsByShot: new Map([
      ["s1", [rec("r1", { shotId: "s1", version: 1, outputAssetId: "vA" })]],
      [
        "s2",
        [
          rec("r2", { shotId: "s2", version: 1, outputAssetId: "vC" }),
          rec("r3", { shotId: "s2", version: 2, outputAssetId: "vD" }),
        ],
      ],
    ]),
    usableAssetIds: new Set(["vA", "vC"]),
  });
  assert.deepEqual(
    plan.clips.map((c) => [c.shotId, c.assetId, c.startTime, c.duration]),
    [
      ["s1", "vA", 0, 4],
      ["s2", "vC", 4, 6],
    ],
  );
  assert.equal(plan.duration, 10);
});

test("buildAutoTimelinePlan：空项目 → 空计划；非法时长跳过", () => {
  assert.deepEqual(buildAutoTimelinePlan({ scenes: [], storyboards: [], shots: [] }).clips, []);
  const plan = buildAutoTimelinePlan({
    scenes: [{ id: "sc1", order: 0 }],
    storyboards: [{ id: "sb1", sceneId: "sc1", order: 0 }],
    shots: [shot("s1", { duration: 0, videoAssetId: "v1" })],
  });
  assert.equal(plan.clips.length, 0);
  assert.equal(plan.skipped[0]!.reason, "镜头时长非法，无法入轨");
});

test("buildAutoTimelinePlan：跨场景按 scene order 聚合（scene2 整体排在 scene1 后）", () => {
  const plan = buildAutoTimelinePlan({
    scenes: [
      { id: "sc2", order: 1 },
      { id: "sc1", order: 0 },
    ],
    storyboards: [
      { id: "sb1", sceneId: "sc1", order: 0 },
      { id: "sb2", sceneId: "sc2", order: 0 },
    ],
    shots: [
      shot("s2-1", { storyboardId: "sb2", duration: 2, videoAssetId: "v2" }),
      shot("s1-1", { storyboardId: "sb1", duration: 4, videoAssetId: "v1" }),
    ],
  });
  assert.equal(plan.duration, 6);
  assert.deepEqual(
    plan.clips.map((c) => [c.shotId, c.startTime]),
    [
      ["s1-1", 0],
      ["s2-1", 4],
    ],
  );
});
