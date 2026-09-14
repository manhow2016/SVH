/**
 * 分镜领域契约测试
 *
 * 锁住三件最容易被改坏的事：
 * 1. 机位/台词的结构（写进 JSON 列前必须被校验）
 * 2. 时长与 index 的取值边界
 * 3. index 连续性 —— 它是 UI 顺序与 Timeline 顺序的共同前提
 */
import { describe, expect, it } from 'vitest';

import {
  assertContiguousIndices,
  cameraSchema,
  createShotSchema,
  dialogueSchema,
  reindex,
  reorderShotsSchema,
  updateShotSchema,
} from '../src/index.js';

describe('分镜领域契约', () => {
  it('机位三字段全可选，且拒绝未知键', () => {
    expect(cameraSchema.parse({})).toEqual({});
    expect(cameraSchema.parse({ shotType: '中景', movement: '推进' })).toEqual({
      shotType: '中景',
      movement: '推进',
    });
    expect(() => cameraSchema.parse({ shotSize: '中景' })).toThrow();
  });

  it('台词必须非空，可选绑定角色 slug', () => {
    expect(dialogueSchema.parse({ text: '你终于来了。' })).toEqual({ text: '你终于来了。' });
    expect(dialogueSchema.parse({ characterSlug: '苏晚', text: '嗯。' }).characterSlug).toBe('苏晚');
    expect(() => dialogueSchema.parse({ text: '' })).toThrow();
  });

  it('时长必须为正数', () => {
    expect(() => createShotSchema.parse({ contentId: 'c1', durationSeconds: 0 })).toThrow();
    expect(() => createShotSchema.parse({ contentId: 'c1', durationSeconds: -1 })).toThrow();
    expect(createShotSchema.parse({ contentId: 'c1', durationSeconds: 3.5 }).durationSeconds).toBe(3.5);
  });

  it('创建镜头时 description 默认空串、dialogue 默认空数组', () => {
    const input = createShotSchema.parse({ contentId: 'c1', durationSeconds: 2 });
    expect(input.description).toBe('');
    expect(input.dialogue).toEqual([]);
    expect(input.camera).toEqual({});
  });

  it('更新镜头是部分更新：只给一个机位字段也应通过', () => {
    expect(updateShotSchema.parse({ camera: { movement: '推进' } })).toEqual({
      camera: { movement: '推进' },
    });
    expect(updateShotSchema.parse({})).toEqual({});
    expect(() => updateShotSchema.parse({ unknownField: 1 })).toThrow();
  });

  it('重排要求非空 id 列表', () => {
    expect(reorderShotsSchema.parse({ contentId: 'c1', orderedShotIds: ['s1'] }).orderedShotIds).toEqual(['s1']);
    expect(() => reorderShotsSchema.parse({ contentId: 'c1', orderedShotIds: [] })).toThrow();
  });

  it('index 必须从 0 连续：接受 0..n-1，拒绝跳号与重复', () => {
    expect(() =>
      assertContiguousIndices([
        { id: 'a', index: 0 },
        { id: 'b', index: 1 },
      ]),
    ).not.toThrow();

    expect(() =>
      assertContiguousIndices([
        { id: 'a', index: 0 },
        { id: 'b', index: 2 },
      ]),
    ).toThrow(/不连续/);

    expect(() =>
      assertContiguousIndices([
        { id: 'a', index: 0 },
        { id: 'b', index: 0 },
      ]),
    ).toThrow(/不连续/);
  });

  it('reindex 生成 0..n-1 的映射', () => {
    expect(reindex(['b', 'a', 'c'])).toEqual([
      { id: 'b', index: 0 },
      { id: 'a', index: 1 },
      { id: 'c', index: 2 },
    ]);
  });
});
