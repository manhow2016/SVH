/**
 * 导演动作（Director Action）领域契约
 *
 * ── 为什么 22 种全部登记、却只注册 8 种 payload ──
 * 枚举是**协议面**：数据库列、SSE 事件、界面文案都要能表达「AI 想做这件事」，
 * 因此 22 种一次登记齐全，避免每接一个动作就改一次枚举与迁移。
 * payload 是**能力面**：只有真能被校验与执行的动作才该有 schema。
 * 未注册的类型在落库前抛 `ValidationError`，文案直接列出当前支持哪些 ——
 * 这比留一个 TODO 占位或静默落库更诚实，也与仓库既有的
 * 「未实现技能由任务终态明确表达」口径一致。
 *
 * ── 为什么确认规则是纯函数 ──
 * `requiresConfirmation` 若由调用方填写，它迟早会被填成 `false`。
 * 放在这里由类型与目标数量推导，AI 与用户走同一条规则，且可以单测。
 */
import { z } from 'zod';

import { durationSecondsSchema, idSchema } from './common.js';
import { cameraSchema, dialogueSchema } from './storyboard.js';
import { clipStartSecondsSchema, timelineTrackKindSchema } from './timeline.js';
import {
  DIRECTOR_ACTION_STATUSES,
  DIRECTOR_ACTION_TYPES,
  DIRECTOR_ACTORS,
  type DirectorActionType,
} from './enums.js';
import { ValidationError } from './errors.js';

export const directorActionTypeSchema = z.enum(DIRECTOR_ACTION_TYPES);
export const directorActionStatusSchema = z.enum(DIRECTOR_ACTION_STATUSES);
export const directorActorSchema = z.enum(DIRECTOR_ACTORS);

/** 动作指向的实体：id 一律用领域 id 契约 */
export const ACTION_TARGET_TYPES = [
  'project',
  'content',
  'shot',
  'asset',
  'timeline',
  'task',
  'workflow',
] as const;

export type ActionTargetType = (typeof ACTION_TARGET_TYPES)[number];

export const actionTargetSchema = z
  .object({
    type: z.enum(ACTION_TARGET_TYPES),
    id: idSchema,
  })
  .strict();

export type ActionTarget = z.infer<typeof actionTargetSchema>;

/**
 * 按实体类型收窄的目标数组。
 *
 * `actionTargetSchema` 允许 7 种实体任选，若注册表直接复用它，
 * `create_shot` 可以指向 `workflow`、`delete_asset` 可以指向 `project` ——
 * 这类错配要到数据层才炸，且炸成 500 而不是解析边界的 400。
 * 规范 §4.3 的表格逐动作规定了目标实体，这里把它编译进 schema：
 * 目标实体与动作不匹配时，在 `parseActionPayload` 这一步就被拒绝。
 */
function targetsFor(entity: ActionTargetType, count: { exact: number } | { min: number }) {
  const item = z.object({ type: z.literal(entity), id: idSchema }).strict();
  return 'exact' in count ? z.array(item).length(count.exact) : z.array(item).min(count.min);
}

/** 镜头改动的公共形状：create 与 update 共用一份字段定义 */
const shotChangeShape = {
  durationSeconds: durationSecondsSchema.optional(),
  description: z.string().max(2000).optional(),
  camera: cameraSchema.partial().optional(),
  emotion: z.string().max(64).nullable().optional(),
  dialogue: z.array(dialogueSchema).max(50).optional(),
};

/**
 * 时间线片段的改动（`create_timeline` / `update_timeline` 共用）。
 *
 * `startSeconds` **复用** `timeline.ts` 导出的 `clipStartSecondsSchema`，不手抄：
 * 同形状再写一遍就会漏掉 `.finite()`，而 `Infinity` 是可达输入
 * （`JSON.parse('{"startSeconds":1e999}')`），落库后 JSONB 会把它静默变成 `null`
 * —— 见终审 Important 1 与 Ruling 10 / 25。
 */
const clipChangeSchema = z
  .object({
    source: z.enum(['shot', 'asset']),
    id: idSchema,
    startSeconds: clipStartSecondsSchema,
    durationSeconds: durationSecondsSchema,
  })
  .strict();

/**
 * 已接入的动作 payload 注册表。
 *
 * 每一项都是 `{ targets, changes }` 二元结构：`targets` 决定「改哪些」，
 * `changes` 决定「改成什么」，两者的组合才能算出是否需要用户确认。
 * 目标实体按规范 §4.3 逐动作收窄，不使用宽版 `actionTargetSchema`。
 */
export const DIRECTOR_ACTION_SCHEMAS = {
  create_shot: z
    .object({
      targets: targetsFor('content', { exact: 1 }),
      changes: z
        .object({
          ...shotChangeShape,
          durationSeconds: durationSecondsSchema,
          afterShotId: idSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  update_shot: z
    .object({
      targets: targetsFor('shot', { min: 1 }),
      changes: z.object(shotChangeShape).strict(),
    })
    .strict(),
  delete_shot: z
    .object({
      targets: targetsFor('shot', { min: 1 }),
      changes: z.object({}).strict(),
    })
    .strict(),
  reorder_shots: z
    .object({
      targets: targetsFor('content', { exact: 1 }),
      changes: z.object({ orderedShotIds: z.array(idSchema).min(1) }).strict(),
    })
    .strict(),
  create_timeline: z
    .object({
      targets: targetsFor('content', { exact: 1 }),
      changes: z
        .object({
          tracks: z
            .array(
              z
                .object({
                  kind: timelineTrackKindSchema,
                  label: z.string().max(64).optional(),
                  clips: z.array(clipChangeSchema),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    })
    .strict(),
  update_timeline: z
    .object({
      targets: targetsFor('content', { exact: 1 }),
      changes: z
        .object({
          tracks: z
            .array(
              z
                .object({
                  kind: timelineTrackKindSchema,
                  label: z.string().max(64).optional(),
                  clips: z.array(clipChangeSchema),
                })
                .strict(),
            )
            .optional(),
          clips: z.array(clipChangeSchema).optional(),
        })
        .strict(),
    })
    .strict(),
  update_asset: z
    .object({
      targets: targetsFor('asset', { min: 1 }),
      changes: z
        .object({
          changes: z.record(z.string(), z.unknown()),
          overwrite: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  delete_asset: z
    .object({
      targets: targetsFor('asset', { min: 1 }),
      changes: z.object({}).strict(),
    })
    .strict(),
} as const;

export type ImplementedDirectorActionType = keyof typeof DIRECTOR_ACTION_SCHEMAS;

/** 该动作类型的 payload 是否已接入 */
export function isActionTypeImplemented(type: string): type is ImplementedDirectorActionType {
  return Object.prototype.hasOwnProperty.call(DIRECTOR_ACTION_SCHEMAS, type);
}

/** 校验并归一 payload；未接入的类型在此被明确拒绝 */
export function parseActionPayload(
  type: string,
  payload: unknown,
): { targets: ActionTarget[]; changes: Record<string, unknown> } {
  if (!isActionTypeImplemented(type)) {
    const supported = Object.keys(DIRECTOR_ACTION_SCHEMAS).join(' / ');
    throw new ValidationError(
      `动作类型 ${type} 尚未接入：当前版本只支持 ${supported}`,
      { issues: { type, supported } },
    );
  }

  // 无需断言：注册表各项的 `targets` / `changes` 推断类型恰好就是返回类型
  const parsed = DIRECTOR_ACTION_SCHEMAS[type].parse(payload);
  return {
    targets: parsed.targets,
    changes: parsed.changes,
  };
}

/**
 * 需要确认的动作类型（规范 §13）。
 *
 * 「导出 / 发布」不在这里：它们由任务级闸门（`highCost` / `risk:'high'`）
 * 负责，两套确认各管各的，不重复表达。
 *
 * `as const satisfies readonly DirectorActionType[]`：既保留字面量元组
 * （测试可全量 `toEqual`），又让拼错的类型名在**编译期**就失败 ——
 * 之前写成 `readonly string[]` 时，写成 `'delete_shots'` 也能通过编译，
 * 于是「删除类动作必须确认」这条规则会静默失效。
 */
export const ALWAYS_CONFIRM_ACTION_TYPES = [
  'delete_asset',
  'delete_shot',
  'generate_image',
  'generate_video',
  'generate_audio',
  'run_workflow',
  'run_task',
  'repair_project',
] as const satisfies readonly DirectorActionType[];

/** 超过一个目标即视为批量（规范 §13 的「批量修改 / 批量删除 / 批量生成」） */
export const BATCH_CONFIRM_THRESHOLD = 1;

export interface ConfirmationInput {
  type: string;
  targets: readonly unknown[];
  changes: Record<string, unknown>;
}

/**
 * 确认集合的查找结构。
 *
 * 字面量元组的 `includes` 只接受自身字面量联合（传 `input.type: string` 会报错），
 * 因此用 `ReadonlySet<string>` 取 `has`。`Set` 不继承自 `Object.prototype`
 * 的可枚举键，顺带避免了 `canTransitionDirectorAction` 那类原型链陷阱。
 */
const ALWAYS_CONFIRM_SET: ReadonlySet<string> = new Set(ALWAYS_CONFIRM_ACTION_TYPES);

/** 由动作自身推导是否需要用户确认；不接受调用方直接指定 */
export function requiresConfirmation(input: ConfirmationInput): boolean {
  if (ALWAYS_CONFIRM_SET.has(input.type)) {
    return true;
  }
  if (input.targets.length > BATCH_CONFIRM_THRESHOLD) {
    return true;
  }
  return input.changes['overwrite'] === true;
}

/**
 * 动作状态机白名单。
 *
 * `failed → approved` 是**有意的**：失败的动作允许在用户重新批准后重试，
 * 而不是逼用户重新提一遍需求。`executed / rejected / cancelled` 为终态。
 */
export const DIRECTOR_ACTION_TRANSITIONS = {
  proposed: ['awaiting_confirmation', 'approved', 'cancelled'],
  awaiting_confirmation: ['approved', 'rejected', 'cancelled'],
  approved: ['executing', 'cancelled'],
  executing: ['executed', 'failed'],
  failed: ['approved', 'cancelled'],
  executed: [],
  rejected: [],
  cancelled: [],
} as const satisfies Record<
  (typeof DIRECTOR_ACTION_STATUSES)[number],
  readonly (typeof DIRECTOR_ACTION_STATUSES)[number][]
>;

/**
 * 判断动作状态转移是否合法。
 *
 * 只认表内的自有键：`DIRECTOR_ACTION_TRANSITIONS` 是普通对象字面量，
 * 若直接用它索引，`from` 为 `'toString'` / `'constructor'` / `'__proto__'`
 * 这类原型链上的键时会取到继承来的函数或对象，`.includes` 不存在，
 * 于是抛 `TypeError` 而不是按契约返回 `false` —— 写库前的校验路径不能
 * 因为一个陌生字符串就抛类型错误。同文件的 `isActionTypeImplemented`
 * 用的是同一套口径（只认自有属性），两处保持一致。
 *
 * 用 `Set`（而非 `Object.hasOwn` 守卫）是因为 `Set` 本就不继承
 * `Object.prototype` 的任何键，且避免了对「`as const` 字面量元组联合」
 * 取索引时 `.includes` 的参数被收窄成 `never` 的类型噪音。
 */
const TRANSITION_STATUSES: ReadonlySet<string> = new Set(Object.keys(DIRECTOR_ACTION_TRANSITIONS));

export function canTransitionDirectorAction(from: string, to: string): boolean {
  if (!TRANSITION_STATUSES.has(from)) {
    return false;
  }
  const allowed: readonly string[] =
    DIRECTOR_ACTION_TRANSITIONS[from as keyof typeof DIRECTOR_ACTION_TRANSITIONS];
  return allowed.includes(to);
}

/** 非法转移直接抛错 */
export function assertDirectorActionTransition(from: string, to: string): void {
  if (!canTransitionDirectorAction(from, to)) {
    throw new Error(`非法的动作状态转移：${from} → ${to}`);
  }
}
