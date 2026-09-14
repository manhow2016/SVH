/**
 * 时间线领域契约测试
 *
 * 重点是「一个片段恰好一个来源」这条约束在**领域层**的表现，
 * 以及同轨不重叠。数据库层还有一条 CHECK 兜底，两层各有测试。
 */
import { describe, expect, it } from 'vitest';

import {
  assertNoOverlap,
  createClipSchema,
  moveClipSchema,
  timelineClipSchema,
  timelineClipSourceSchema,
  timelineDurationSeconds,
  updateClipSchema,
} from '../src/index.js';

const clip = (over: Record<string, unknown> = {}) => ({
  id: 'clip1',
  trackId: 'track1',
  shotId: 'shot1',
  assetId: null,
  startSeconds: 0,
  durationSeconds: 2,
  ...over,
});

describe('时间线领域契约', () => {
  it('片段来源是判别联合：shot 或 asset，二选一', () => {
    expect(timelineClipSourceSchema.parse({ source: 'shot', shotId: 's1' })).toEqual({
      source: 'shot',
      shotId: 's1',
    });
    expect(timelineClipSourceSchema.parse({ source: 'asset', assetId: 'a1' })).toEqual({
      source: 'asset',
      assetId: 'a1',
    });
    expect(() => timelineClipSourceSchema.parse({ source: 'shot', assetId: 'a1' })).toThrow();
  });

  it('读模型拒绝双来源与无来源', () => {
    expect(timelineClipSchema.parse(clip())).toMatchObject({ shotId: 'shot1', assetId: null });
    expect(() => timelineClipSchema.parse(clip({ assetId: 'a1' }))).toThrow(/一个来源/);
    expect(() => timelineClipSchema.parse(clip({ shotId: null }))).toThrow(/一个来源/);
  });

  it('起点非负、时长为正', () => {
    expect(() => timelineClipSchema.parse(clip({ startSeconds: -1 }))).toThrow();
    expect(() => timelineClipSchema.parse(clip({ durationSeconds: 0 }))).toThrow();
  });

  it('同轨相邻不重叠：首尾相接允许，交叉拒绝', () => {
    expect(() =>
      assertNoOverlap([
        { startSeconds: 0, durationSeconds: 2 },
        { startSeconds: 2, durationSeconds: 3 },
      ]),
    ).not.toThrow();

    expect(() =>
      assertNoOverlap([
        { startSeconds: 0, durationSeconds: 2 },
        { startSeconds: 1.5, durationSeconds: 1 },
      ]),
    ).toThrow(/重叠/);
  });

  it('重叠校验与传入顺序无关', () => {
    expect(() =>
      assertNoOverlap([
        { startSeconds: 5, durationSeconds: 1 },
        { startSeconds: 0, durationSeconds: 2 },
        { startSeconds: 2, durationSeconds: 3 },
      ]),
    ).not.toThrow();
  });

  it('首尾相接且起点略有偏移时不算重叠', () => {
    expect(() =>
      assertNoOverlap([
        { startSeconds: 0, durationSeconds: 2 },
        { startSeconds: 2.0000001, durationSeconds: 1 },
      ]),
    ).not.toThrow();
  });

  it('容差在浮点累加下真正起作用（0.1 + 0.2 的误差不算重叠）', () => {
    expect(() =>
      assertNoOverlap([
        { startSeconds: 0, durationSeconds: 0.1 },
        { startSeconds: 0.1, durationSeconds: 0.2 },
        { startSeconds: 0.3, durationSeconds: 1 },
      ]),
    ).not.toThrow();
  });

  it('总时长取所有轨道片段的最右端，并按毫秒取整', () => {
    const total = timelineDurationSeconds([
      { clips: [{ startSeconds: 0, durationSeconds: 2 }, { startSeconds: 2, durationSeconds: 0.3333 }] },
      { clips: [{ startSeconds: 10, durationSeconds: 0.0004 }] },
    ]);
    expect(total).toBe(10);
  });
});

/**
 * 写路径契约（Ruling 10）
 *
 * ── 为什么读模型有 schema 还不够 ──
 * 仓储原先直接吃裸 number：`startSeconds` 没有任何校验就进 float8 列。
 * 最典型的破口不是负数，而是 `Infinity` —— Fastify 用 `JSON.parse` 解析请求体，
 * 而 `JSON.parse('{"a":1e999}')` 在 JS 里得到的是 `Infinity`（不是报错）。
 * 一旦写进库里，时间线算术会全线污染：`Infinity - 1` 仍是 `Infinity`，
 * 重叠校验拿它比较也判不出问题，剪出来的 EDL 时长直接是 `Infinity`。
 *
 * ── 为什么必须 `.finite()` ──
 * zod 的 `nonnegative()` **放行** `Infinity`（`Infinity >= 0` 为真，已实测），
 * 只有显式 `.finite()` 才拦得住。下面的用例先用 `JSON.parse` 造出真实的
 * `Infinity` 再断言被拒，避免写成一条「永远成立的空转断言」。
 */
describe('时间线写路径契约（Ruling 10）', () => {
  it('createClipSchema 要求恰好一个来源：双给与都不给都拒绝', () => {
    expect(
      createClipSchema.parse({
        trackId: 'track1',
        shotId: 'shot1',
        startSeconds: 0,
        durationSeconds: 2,
      }),
    ).toEqual({ trackId: 'track1', shotId: 'shot1', startSeconds: 0, durationSeconds: 2 });

    expect(
      createClipSchema.parse({
        trackId: 'track1',
        assetId: 'asset1',
        startSeconds: 0,
        durationSeconds: 2,
      }),
    ).toEqual({ trackId: 'track1', assetId: 'asset1', startSeconds: 0, durationSeconds: 2 });

    // 双来源：能通过数据库那条 CHECK 才有鬼，必须在写库前就被拦下
    expect(() =>
      createClipSchema.parse({
        trackId: 'track1',
        shotId: 'shot1',
        assetId: 'asset1',
        startSeconds: 0,
        durationSeconds: 2,
      }),
    ).toThrow(/一个来源/);

    // 无来源
    expect(() =>
      createClipSchema.parse({ trackId: 'track1', startSeconds: 0, durationSeconds: 2 }),
    ).toThrow(/一个来源/);
  });

  it('createClipSchema 的 startSeconds 拒绝 Infinity 与负数', () => {
    // 反空转：先证明这个输入真的是 Infinity —— 否则下面的 toThrow 可能什么都没测到
    const fromJson = JSON.parse('{"startSeconds":1e999}') as { startSeconds: number };
    expect(fromJson.startSeconds).toBe(Number.POSITIVE_INFINITY);

    expect(() =>
      createClipSchema.parse({
        trackId: 'track1',
        shotId: 'shot1',
        startSeconds: fromJson.startSeconds,
        durationSeconds: 2,
      }),
    ).toThrow(/finite/i);

    expect(() =>
      createClipSchema.parse({
        trackId: 'track1',
        shotId: 'shot1',
        startSeconds: -1,
        durationSeconds: 2,
      }),
    ).toThrow();

    // 有限小数必须放行（否则上面的拒绝可能只是「这份 schema 拒绝一切」）
    expect(
      createClipSchema.parse({
        trackId: 'track1',
        shotId: 'shot1',
        startSeconds: 2.5,
        durationSeconds: 2,
      }).startSeconds,
    ).toBe(2.5);
  });

  it('createClipSchema 拒绝拼错的键（strict）', () => {
    expect(() =>
      createClipSchema.parse({
        trackId: 'track1',
        shotId: 'shot1',
        startSeconds: 0,
        durationSeconds: 2,
        startSecond: 0,
      }),
    ).toThrow(/Unrecognized key/i);
  });

  it('updateClipSchema 至少给一个字段，且拒绝 Infinity 与零时长', () => {
    expect(() => updateClipSchema.parse({})).toThrow(/至少/);
    expect(() =>
      updateClipSchema.parse({ startSeconds: Number.POSITIVE_INFINITY }),
    ).toThrow(/finite/i);
    // 0 时长会被 durationSecondsSchema 的 positive 拒绝
    expect(() => updateClipSchema.parse({ durationSeconds: 0 })).toThrow();

    expect(updateClipSchema.parse({ startSeconds: 1.5 })).toEqual({ startSeconds: 1.5 });
    expect(updateClipSchema.parse({ durationSeconds: 1 })).toEqual({ durationSeconds: 1 });
    expect(updateClipSchema.parse({ startSeconds: 0, durationSeconds: 3 })).toEqual({
      startSeconds: 0,
      durationSeconds: 3,
    });
  });

  it('moveClipSchema 至少给一个字段，且拒绝 Infinity', () => {
    expect(() => moveClipSchema.parse({})).toThrow(/至少/);
    expect(() => moveClipSchema.parse({ startSeconds: Number.POSITIVE_INFINITY })).toThrow(
      /finite/i,
    );
    expect(moveClipSchema.parse({ trackId: 'track2' })).toEqual({ trackId: 'track2' });
    // 起点 0 是合法值：不能被「至少给一个字段」的 refine 误判成「没给」
    expect(moveClipSchema.parse({ startSeconds: 0 })).toEqual({ startSeconds: 0 });
  });
});
