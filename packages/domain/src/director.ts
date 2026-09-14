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
import { timelineTrackKindSchema } from './timeline.js';
import {
  DIRECTOR_ACTION_STATUSES,
  DIRECTOR_ACTION_TYPES,
  DIRECTOR_ACTORS,
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

export const actionTargetSchema = z
  .object({
    type: z.enum(ACTION_TARGET_TYPES),
    id: idSchema,
  })
  .strict();

export type ActionTarget = z.infer<typeof actionTargetSchema>;

/** 镜头改动的公共形状：create 与 update 共用一份字段定义 */
const shotChangeShape = {
  durationSeconds: durationSecondsSchema.optional(),
  description: z.string().max(2000).optional(),
  camera: cameraSchema.partial().optional(),
  emotion: z.string().max(64).nullable().optional(),
  dialogue: z.array(dialogueSchema).max(50).optional(),
};

const clipChangeSchema = z
  .object({
    source: z.enum(['shot', 'asset']),
    id: idSchema,
    startSeconds: z.number().nonnegative(),
    durationSeconds: durationSecondsSchema,
  })
  .strict();

/**
 * 已接入的动作 payload 注册表。
 *
 * 每一项都是 `{ targets, changes }` 二元结构：`targets` 决定「改哪些」，
 * `changes` 决定「改成什么」，两者的组合才能算出是否需要用户确认。
 */
export const DIRECTOR_ACTION_SCHEMAS = {
  create_shot: z
    .object({
      targets: z.array(actionTargetSchema).length(1),
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
      targets: z.array(actionTargetSchema).min(1),
      changes: z.object(shotChangeShape).strict(),
    })
    .strict(),
  delete_shot: z
    .object({
      targets: z.array(actionTargetSchema).min(1),
      changes: z.object({}).strict(),
    })
    .strict(),
  reorder_shots: z
    .object({
      targets: z.array(actionTargetSchema).length(1),
      changes: z.object({ orderedShotIds: z.array(idSchema).min(1) }).strict(),
    })
    .strict(),
  create_timeline: z
    .object({
      targets: z.array(actionTargetSchema).length(1),
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
      targets: z.array(actionTargetSchema).length(1),
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
      targets: z.array(actionTargetSchema).min(1),
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
      targets: z.array(actionTargetSchema).min(1),
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
 */
export const ALWAYS_CONFIRM_ACTION_TYPES: readonly string[] = [
  'delete_asset',
  'delete_shot',
  'generate_image',
  'generate_video',
  'generate_audio',
  'run_workflow',
  'run_task',
  'repair_project',
];

/** 超过一个目标即视为批量（规范 §13 的「批量修改 / 批量删除 / 批量生成」） */
export const BATCH_CONFIRM_THRESHOLD = 1;

export interface ConfirmationInput {
  type: string;
  targets: readonly unknown[];
  changes: Record<string, unknown>;
}

/** 由动作自身推导是否需要用户确认；不接受调用方直接指定 */
export function requiresConfirmation(input: ConfirmationInput): boolean {
  if (ALWAYS_CONFIRM_ACTION_TYPES.includes(input.type)) {
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

/** 判断动作状态转移是否合法 */
export function canTransitionDirectorAction(from: string, to: string): boolean {
  const allowed = DIRECTOR_ACTION_TRANSITIONS[from as keyof typeof DIRECTOR_ACTION_TRANSITIONS];
  return (allowed as readonly string[] | undefined)?.includes(to) ?? false;
}

/** 非法转移直接抛错 */
export function assertDirectorActionTransition(from: string, to: string): void {
  if (!canTransitionDirectorAction(from, to)) {
    throw new Error(`非法的动作状态转移：${from} → ${to}`);
  }
}
