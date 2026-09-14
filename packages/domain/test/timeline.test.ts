/**
 * 时间线领域契约测试
 *
 * 重点是「一个片段恰好一个来源」这条约束在**领域层**的表现，
 * 以及同轨不重叠。数据库层还有一条 CHECK 兜底，两层各有测试。
 */
import { describe, expect, it } from 'vitest';

import {
  assertNoOverlap,
  timelineClipSchema,
  timelineClipSourceSchema,
  timelineDurationSeconds,
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
