/**
 * 导演动作领域契约测试
 *
 * 三块内容：
 * 1. 22 种动作**全部登记**（与规范 §12 逐字一致，用硬编码清单守住）
 * 2. payload 注册表：只有已接入的类型能通过校验，其余明确拒绝
 * 3. 确认规则与状态机
 */
import { describe, expect, it } from 'vitest';

import {
  DIRECTOR_ACTION_TYPES,
  DIRECTOR_ACTION_TRANSITIONS,
  assertDirectorActionTransition,
  canTransitionDirectorAction,
  isActionTypeImplemented,
  parseActionPayload,
  requiresConfirmation,
} from '../src/index.js';

/** 规范 §12 的原文清单：任何一侧增删都会让这条断言失败 */
const SPEC_ACTION_TYPES = [
  'create_project',
  'update_project',
  'create_story',
  'update_story',
  'create_script',
  'update_script',
  'create_asset',
  'update_asset',
  'delete_asset',
  'create_shot',
  'update_shot',
  'delete_shot',
  'reorder_shots',
  'generate_image',
  'generate_video',
  'generate_audio',
  'create_timeline',
  'update_timeline',
  'run_workflow',
  'run_task',
  'validate_project',
  'repair_project',
] as const;

describe('导演动作类型登记', () => {
  it('与规范 §12 的 22 种逐字一致', () => {
    expect([...DIRECTOR_ACTION_TYPES]).toEqual([...SPEC_ACTION_TYPES]);
  });

  it('本轮注册 8 种，其余明确未接入', () => {
    expect(isActionTypeImplemented('create_shot')).toBe(true);
    expect(isActionTypeImplemented('delete_asset')).toBe(true);
    expect(isActionTypeImplemented('run_workflow')).toBe(false);
    expect(isActionTypeImplemented('repair_project')).toBe(false);
  });
});

describe('动作 payload 校验', () => {
  it('未接入的类型被拒绝，且文案说明当前支持哪些', () => {
    expect(() => parseActionPayload('run_workflow', { targets: [], changes: {} })).toThrow(
      /尚未接入/,
    );
    expect(() => parseActionPayload('run_workflow', { targets: [], changes: {} })).toThrow(
      /create_shot/,
    );
  });

  it('已接入的类型按 schema 校验', () => {
    const parsed = parseActionPayload('create_shot', {
      targets: [{ type: 'content', id: 'c1' }],
      changes: { durationSeconds: 3, description: '女主走进办公室' },
    });
    expect(parsed.targets).toEqual([{ type: 'content', id: 'c1' }]);
    expect(parsed.changes).toMatchObject({ durationSeconds: 3 });

    expect(() =>
      parseActionPayload('create_shot', {
        targets: [{ type: 'content', id: 'c1' }],
        changes: { description: '缺时长' },
      }),
    ).toThrow();
  });

  it('reorder_shots 要求非空 id 列表', () => {
    expect(() =>
      parseActionPayload('reorder_shots', {
        targets: [{ type: 'content', id: 'c1' }],
        changes: { orderedShotIds: [] },
      }),
    ).toThrow();
  });
});

describe('确认规则（规范 §13）', () => {
  const call = (type: Parameters<typeof requiresConfirmation>[0]['type'], count = 1, changes = {}) =>
    requiresConfirmation({
      type,
      targets: Array.from({ length: count }, (_, i) => ({ type: 'shot', id: `s${i}` })),
      changes,
    });

  it('单个镜头的局部修改不需要确认', () => {
    expect(call('update_shot')).toBe(false);
  });

  it('批量修改需要确认（>1 个目标）', () => {
    expect(call('update_shot', 2)).toBe(true);
  });

  it('删除类动作即使只有一个目标也需要确认', () => {
    expect(call('delete_shot')).toBe(true);
    expect(call('delete_asset')).toBe(true);
  });

  it('生成类与流程类动作需要确认', () => {
    expect(call('generate_image')).toBe(true);
    expect(call('run_workflow')).toBe(true);
  });

  it('覆盖现有版本需要确认（changes.overwrite === true）', () => {
    expect(call('update_asset', 1, { overwrite: true })).toBe(true);
    expect(call('update_asset', 1, { overwrite: false })).toBe(false);
  });
});

describe('动作状态机', () => {
  it('无需确认的动作从 proposed 直接到 approved', () => {
    expect(canTransitionDirectorAction('proposed', 'approved')).toBe(true);
  });

  it('待确认的动作只能走向 approved / rejected / cancelled', () => {
    expect(DIRECTOR_ACTION_TRANSITIONS.awaiting_confirmation).toEqual([
      'approved',
      'rejected',
      'cancelled',
    ]);
  });

  it('终态不可再转移', () => {
    expect(canTransitionDirectorAction('executed', 'approved')).toBe(false);
    expect(canTransitionDirectorAction('rejected', 'approved')).toBe(false);
  });

  it('失败后可以重新批准（重试同一动作）', () => {
    expect(canTransitionDirectorAction('failed', 'approved')).toBe(true);
  });

  it('非法转移抛错并说明方向', () => {
    expect(() => assertDirectorActionTransition('proposed', 'executed')).toThrow(
      /proposed → executed/,
    );
    expect(() => assertDirectorActionTransition('awaiting_confirmation', 'approved')).not.toThrow();
  });
});
