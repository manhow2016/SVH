/**
 * Timeline 领域规则测试（V0.3 文档 §五、§十六）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTimelineStatus,
  assertClipAssetMatchesTrack,
  assertClipWithinTimeline,
  assertSameProject,
  bumpTimelineVersion,
  canTransitionTimelineStatus,
  isTimelineStatus,
  isTimelineTrackType,
  normalizeTimelineClipCreateInput,
  normalizeTimelineCreateInput,
  normalizeTimelineTrackCreateInput,
  validateClipAgainstContext,
} from "../src/index";

// ---- 创建校验 ----

test("normalizeTimelineCreateInput：默认渲染目标 + 名称规范化", () => {
  const out = normalizeTimelineCreateInput({ projectId: "p1", name: " 主时间轴 " });
  assert.equal(out.projectId, "p1");
  assert.equal(out.name, "主时间轴");
  assert.equal(out.duration, 0);
  assert.equal(out.fps, 24);
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
});

test("normalizeTimelineCreateInput：显式覆盖 fps / 尺寸", () => {
  const out = normalizeTimelineCreateInput({
    projectId: "p1",
    name: "t",
    fps: 30,
    width: 1280,
    height: 720,
  });
  assert.equal(out.fps, 30);
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);
});

test("normalizeTimelineCreateInput：非法输入抛校验错误", () => {
  assert.throws(() => normalizeTimelineCreateInput({ projectId: "p1", name: "  " }), /不能为空/);
  assert.throws(
    () => normalizeTimelineCreateInput({ projectId: "p1", name: "t", fps: 0 }),
    /FPS/,
  );
  assert.throws(
    () => normalizeTimelineCreateInput({ projectId: "p1", name: "t", width: -1 }),
    /宽度/,
  );
  assert.throws(
    () => normalizeTimelineCreateInput({ projectId: "p1", name: "t", width: 1920.5 }),
    /整数/,
  );
});

// ---- Track ----

test("normalizeTimelineTrackCreateInput：类型/名称/顺序校验", () => {
  const track = normalizeTimelineTrackCreateInput({
    timelineId: "tl1",
    type: "video",
    name: " 主视频轨 ",
    order: 0,
  });
  assert.equal(track.type, "video");
  assert.equal(track.name, "主视频轨");
  assert.equal(track.order, 0);

  assert.throws(
    () =>
      normalizeTimelineTrackCreateInput({
        timelineId: "tl1",
        // @ts-expect-error —— 模拟运行时非法值，验证领域校验拦截
        type: "effects", // 未知类型
        name: "x",
      }),
    /轨道类型/,
  );
  assert.throws(
    () =>
      normalizeTimelineTrackCreateInput({ timelineId: "tl1", type: "audio", name: "x", order: -1 }),
    />= 0/,
  );
});

// ---- Clip 字段级规则（1/2） ----

test("normalizeTimelineClipCreateInput：startTime >= 0、duration > 0", () => {
  const clip = normalizeTimelineClipCreateInput({
    timelineId: "tl1",
    trackId: "tr1",
    assetId: "asset1",
    startTime: 5,
    duration: 3,
  });
  assert.equal(clip.startTime, 5);
  assert.equal(clip.duration, 3);

  assert.throws(
    () =>
      normalizeTimelineClipCreateInput({
        timelineId: "tl1",
        trackId: "tr1",
        startTime: -1,
        duration: 1,
      }),
    />= 0/,
  );
  assert.throws(
    () =>
      normalizeTimelineClipCreateInput({
        timelineId: "tl1",
        trackId: "tr1",
        startTime: 0,
        duration: 0,
      }),
    /正数/,
  );
});

test("normalizeTimelineClipCreateInput：sourceStartTime 允许 0，sourceDuration 必须 > 0", () => {
  const out = normalizeTimelineClipCreateInput({
    timelineId: "tl1",
    trackId: "tr1",
    startTime: 0,
    duration: 2,
    sourceStartTime: 0,
    sourceDuration: 2,
  });
  assert.equal(out.sourceStartTime, 0);
  assert.equal(out.sourceDuration, 2);

  assert.throws(
    () =>
      normalizeTimelineClipCreateInput({
        timelineId: "tl1",
        trackId: "tr1",
        startTime: 0,
        duration: 1,
        sourceStartTime: -0.5,
      }),
    />= 0/,
  );
});

// ---- 规则 6：不超出时间轴 ----

test("assertClipWithinTimeline：允许贴边、拒绝越界", () => {
  assert.doesNotThrow(() => assertClipWithinTimeline(5, 3, 8));
  assert.doesNotThrow(() => assertClipWithinTimeline(0, 15, 15));
  assert.throws(() => assertClipWithinTimeline(5, 3.1, 8), /超出时间轴范围/);
  assert.throws(() => assertClipWithinTimeline(8, 3, 8), /超出时间轴范围/);
});

// ---- 规则 3/4：轨道与资产匹配 ----

test("assertClipAssetMatchesTrack：video/audio 强制绑定", () => {
  assert.doesNotThrow(() => assertClipAssetMatchesTrack("video", "video"));
  assert.doesNotThrow(() => assertClipAssetMatchesTrack("audio", "audio"));
  assert.throws(() => assertClipAssetMatchesTrack("video", undefined), /必须关联视频资产/);
  assert.throws(() => assertClipAssetMatchesTrack("video", "audio"), /要求 video 资产/);
  assert.throws(() => assertClipAssetMatchesTrack("audio", "video"), /要求 audio 资产/);
});

test("assertClipAssetMatchesTrack：subtitle/overlay 第一阶段宽松", () => {
  assert.doesNotThrow(() => assertClipAssetMatchesTrack("subtitle", undefined));
  assert.doesNotThrow(() => assertClipAssetMatchesTrack("overlay", undefined));
  assert.doesNotThrow(() => assertClipAssetMatchesTrack("subtitle", "subtitle"));
  assert.doesNotThrow(() => assertClipAssetMatchesTrack("overlay", "image"));
  assert.throws(() => assertClipAssetMatchesTrack("subtitle", "video"), /要求 subtitle 资产/);
  assert.throws(() => assertClipAssetMatchesTrack("overlay", "video"), /要求 image 资产/);
});

// ---- 规则 7/8：项目隔离 ----

test("assertSameProject：跨项目引用被拒绝", () => {
  assert.doesNotThrow(() => assertSameProject("p1", "p1", "资产 asset1"));
  assert.throws(() => assertSameProject("p1", "p2", "资产 asset1"), /不属于当前项目/);
});

test("validateClipAgainstContext：组合校验一次执行", () => {
  const ctx = {
    timeline: { duration: 15, projectId: "p1" },
    track: { type: "video" as const },
    asset: { type: "video" as const, projectId: "p1" },
    shot: { projectId: "p1" },
  };
  assert.doesNotThrow(() =>
    validateClipAgainstContext(
      { assetId: "asset1", shotId: "shot1", startTime: 0, duration: 5 },
      ctx,
    ),
  );

  // 越界
  assert.throws(
    () =>
      validateClipAgainstContext(
        { assetId: "asset1", shotId: "shot1", startTime: 12, duration: 5 },
        ctx,
      ),
    /超出时间轴范围/,
  );
  // 缺资产绑定
  assert.throws(
    () =>
      validateClipAgainstContext(
        { assetId: undefined, shotId: "shot1", startTime: 0, duration: 5 },
        ctx,
      ),
    /必须关联资产/,
  );
  // 资产类型不匹配
  assert.throws(
    () =>
      validateClipAgainstContext(
        { assetId: "audio1", shotId: "shot1", startTime: 0, duration: 5 },
        { ...ctx, asset: { type: "audio" as const, projectId: "p1" } },
      ),
    /要求 video 资产/,
  );
  // 跨项目资产
  assert.throws(
    () =>
      validateClipAgainstContext(
        { assetId: "asset1", shotId: "shot1", startTime: 0, duration: 5 },
        { ...ctx, asset: { type: "video" as const, projectId: "p2" } },
      ),
    /不属于当前项目/,
  );
  // 跨项目镜头
  assert.throws(
    () =>
      validateClipAgainstContext(
        { assetId: "asset1", shotId: "shot1", startTime: 0, duration: 5 },
        { ...ctx, shot: { projectId: "p2" } },
      ),
    /不属于当前项目/,
  );
});

// ---- 状态机与版本 ----

test("Timeline 状态机：合法/非法跳转", () => {
  assert.equal(canTransitionTimelineStatus("draft", "ready"), true);
  assert.equal(canTransitionTimelineStatus("ready", "rendering"), true);
  assert.equal(canTransitionTimelineStatus("rendering", "completed"), true);
  assert.equal(canTransitionTimelineStatus("rendering", "failed"), true);
  assert.equal(canTransitionTimelineStatus("rendering", "editing"), false);
  assert.equal(canTransitionTimelineStatus("draft", "rendering"), false);
  assert.equal(applyTimelineStatus("draft", "editing"), "editing");
  assert.equal(applyTimelineStatus("completed", "editing"), "editing");
  assert.throws(() => applyTimelineStatus("rendering", "editing"), /不允许从 rendering/);
  assert.throws(() => applyTimelineStatus("ready", "failed"), /不允许从 ready/);
});

test("bumpTimelineVersion：版本号递增与异常输入", () => {
  assert.equal(bumpTimelineVersion(0), 1);
  assert.equal(bumpTimelineVersion(3), 4);
  assert.throws(() => bumpTimelineVersion(-1), />= 0/);
  assert.throws(() => bumpTimelineVersion(1.5), /整数/);
});

// ---- 类型守卫 ----

test("isTimelineStatus / isTimelineTrackType", () => {
  assert.equal(isTimelineStatus("draft"), true);
  assert.equal(isTimelineStatus("editing"), true);
  assert.equal(isTimelineStatus("rendering"), true);
  assert.equal(isTimelineStatus("published"), false);
  assert.equal(isTimelineTrackType("video"), true);
  assert.equal(isTimelineTrackType("audio"), true);
  assert.equal(isTimelineTrackType("subtitle"), true);
  assert.equal(isTimelineTrackType("overlay"), true);
  assert.equal(isTimelineTrackType("effects"), false);
});
