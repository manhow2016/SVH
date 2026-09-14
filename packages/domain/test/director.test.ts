/**
 * 导演动作领域契约测试
 *
 * 三块内容：
 * 1. 22 种动作**全部登记**（与规范 §12 逐字一致，用硬编码清单守住）
 * 2. payload 注册表：只有已接入的类型能通过校验，其余明确拒绝
 * 3. 确认规则与状态机
 */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  ALWAYS_CONFIRM_ACTION_TYPES,
  DIRECTOR_ACTION_SCHEMAS,
  DIRECTOR_ACTION_TYPES,
  DIRECTOR_ACTION_TRANSITIONS,
  ValidationError,
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
    // 全量名单（文件内既有顺序）：只看 isActionTypeImplemented 探针的话，
    // 悄悄加第 9 个 schema 不会有任何用例变红
    expect(Object.keys(DIRECTOR_ACTION_SCHEMAS)).toEqual([
      'create_shot',
      'update_shot',
      'delete_shot',
      'reorder_shots',
      'create_timeline',
      'update_timeline',
      'update_asset',
      'delete_asset',
    ]);
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
    // 钉住结构化错误契约：V0.3-2 的 API 层靠这个类型映射 HTTP 400 + §44 错误信封
    expect(() => parseActionPayload('run_workflow', { targets: [], changes: {} })).toThrow(
      ValidationError,
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
    // 断言具体错误而不是裸 toThrow()：原先的写法在 RED 阶段会被
    // 「parseActionPayload 尚未定义」的 TypeError 满足，属于假绿
    expect(() =>
      parseActionPayload('reorder_shots', {
        targets: [{ type: 'content', id: 'c1' }],
        changes: { orderedShotIds: [] },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseActionPayload('reorder_shots', {
        targets: [{ type: 'content', id: 'c1' }],
        changes: { orderedShotIds: [] },
      }),
    ).toThrow(/orderedShotIds/);
  });

  /**
   * 目标实体必须与动作匹配（规范 §4.3）。
   *
   * 每对输入都成对断言：「换错实体 + 其余字段合法」必须抛错，
   * 「正确实体 + 同样字段」必须通过 —— 只测前者的话，用例可能因为
   * 别的原因（例如 changes 本身不合法）抛错而**假绿**。
   */
  it('目标实体类型按动作收窄（规范 §4.3）', () => {
    const cases: {
      action: string;
      right: string;
      wrong: string;
      changes: Record<string, unknown>;
    }[] = [
      { action: 'create_shot', right: 'content', wrong: 'workflow', changes: { durationSeconds: 3 } },
      { action: 'update_shot', right: 'shot', wrong: 'asset', changes: { description: 'x' } },
      { action: 'delete_shot', right: 'shot', wrong: 'content', changes: {} },
      { action: 'reorder_shots', right: 'content', wrong: 'shot', changes: { orderedShotIds: ['s1'] } },
      {
        action: 'create_timeline',
        right: 'content',
        wrong: 'timeline',
        changes: { tracks: [{ kind: 'video', clips: [] }] },
      },
      { action: 'update_timeline', right: 'content', wrong: 'project', changes: {} },
      { action: 'update_asset', right: 'asset', wrong: 'project', changes: { changes: {} } },
      { action: 'delete_asset', right: 'asset', wrong: 'project', changes: {} },
    ];

    for (const { action, right, wrong, changes } of cases) {
      expect(() =>
        parseActionPayload(action, { targets: [{ type: wrong, id: 'x1' }], changes }),
      ).toThrow(ZodError);
      expect(
        parseActionPayload(action, { targets: [{ type: right, id: 'x1' }], changes }),
      ).toEqual({ targets: [{ type: right, id: 'x1' }], changes });
    }
  });

  /**
   * 时间线 payload 的 `startSeconds` 必须拒绝 `Infinity`（终审 Important 1）。
   *
   * ── 为什么这条用例是判别性的 ──
   * `JSON.parse('{"startSeconds":1e999}')` 不报错 —— 它得到的是真实的 `Infinity`
   * （Fastify 默认就用 `JSON.parse` 解析请求体），而 zod 的 `nonnegative()` 对
   * `Infinity` 判真。`clipChangeSchema` 原先手抄 `timeline.ts` 的起点契约时漏了
   * `.finite()`，于是 `1e999` 能过 payload 校验、落成 `approved`，再由 JSONB
   * 把 `Infinity` 静默写成 `null`。下面先证明输入真的是 `Infinity`，再断言两条
   * 写路径都拒绝它，最后用同形状的有限值做正例 —— 否则「拒绝」可能只是这份
   * schema 拒绝一切。
   */
  it('时间线 payload 的 startSeconds 拒绝 Infinity（create_timeline / update_timeline）', () => {
    const fromJson = JSON.parse('{"startSeconds":1e999}') as { startSeconds: number };
    // 反空转：先证明这真的是 Infinity
    expect(fromJson.startSeconds).toBe(Number.POSITIVE_INFINITY);

    const targets = [{ type: 'content', id: 'c1' }];
    const clip = (startSeconds: number) => ({
      source: 'shot',
      id: 's1',
      startSeconds,
      durationSeconds: 2,
    });

    // create_timeline：changes.tracks[].clips[].startSeconds
    expect(() =>
      parseActionPayload('create_timeline', {
        targets,
        changes: { tracks: [{ kind: 'video', clips: [clip(fromJson.startSeconds)] }] },
      }),
    ).toThrow(/finite/i);

    // update_timeline：changes.clips[].startSeconds（同一条 clipChangeSchema 的另一处挂载）
    expect(() =>
      parseActionPayload('update_timeline', {
        targets,
        changes: { clips: [clip(fromJson.startSeconds)] },
      }),
    ).toThrow(/finite/i);

    // 反空转：同一形状的有限值必须通过
    expect(
      parseActionPayload('create_timeline', {
        targets,
        changes: { tracks: [{ kind: 'video', clips: [clip(2.5)] }] },
      }).changes,
    ).toEqual({ tracks: [{ kind: 'video', clips: [clip(2.5)] }] });
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

  it('固定确认集合与规范 §13 逐字一致', () => {
    // 全量比对：单点探针删掉 run_task / repair_project / generate_video /
    // generate_audio 中任一项都不会变红
    expect([...ALWAYS_CONFIRM_ACTION_TYPES]).toEqual([
      'delete_asset',
      'delete_shot',
      'generate_image',
      'generate_video',
      'generate_audio',
      'run_workflow',
      'run_task',
      'repair_project',
    ]);
  });

  it('覆盖现有版本需要确认（changes.overwrite === true）', () => {
    expect(call('update_asset', 1, { overwrite: true })).toBe(true);
    expect(call('update_asset', 1, { overwrite: false })).toBe(false);
    // 键缺失必须等同于「不覆盖」：这条才能区分 `=== true` 与 `!== false`
    expect(call('update_asset', 1, {})).toBe(false);
  });
});

describe('动作状态机', () => {
  it('无需确认的动作从 proposed 直接到 approved', () => {
    expect(canTransitionDirectorAction('proposed', 'approved')).toBe(true);
  });

  it('整张转移表与规范 §4.4 逐字一致', () => {
    // 全量比对：只做点状断言的话，给 proposed 加 'executed'、
    // 给 failed 加 'rejected' 都不会有任何用例变红
    expect(DIRECTOR_ACTION_TRANSITIONS).toEqual({
      proposed: ['awaiting_confirmation', 'approved', 'cancelled'],
      awaiting_confirmation: ['approved', 'rejected', 'cancelled'],
      approved: ['executing', 'cancelled'],
      executing: ['executed', 'failed'],
      failed: ['approved', 'cancelled'],
      executed: [],
      rejected: [],
      cancelled: [],
    });
  });

  it('未知状态不抛错，按契约返回 false', () => {
    expect(canTransitionDirectorAction('nope', 'approved')).toBe(false);
    // 原型链上的键不能被当成合法状态：普通对象字面量会取到继承来的函数，
    // 进而抛 TypeError 而不是返回 false
    expect(canTransitionDirectorAction('toString', 'approved')).toBe(false);
    expect(canTransitionDirectorAction('constructor', 'approved')).toBe(false);
    expect(canTransitionDirectorAction('__proto__', 'approved')).toBe(false);
    expect(canTransitionDirectorAction('valueOf', 'approved')).toBe(false);
    expect(canTransitionDirectorAction('hasOwnProperty', 'approved')).toBe(false);
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
