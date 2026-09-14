/**
 * 导演动作仓储
 *
 * ── 与任务级确认的关系 ──
 * 这是**动作级**确认：管「批量 / 删除 / 覆盖」这类变更提案。
 * 任务级的 `waiting_user` + `confirmedAt`（高风险技能）原样保留，
 * 两套状态机互不依赖，界面可以把它们合并成一张确认卡。
 * 一个动作执行时可能派生 0..N 个任务，派生关系通过 `result.taskIds` 回写。
 *
 * ── 为什么确认与执行态写入都用 CAS ──
 * 动作可能被界面重复提交（双击「全部更新」）、也可能被后台执行器与用户
 * 同时推进。所有状态写入都要求「读取时的状态仍然是当前状态」，
 * 否则明确失败而不是静默覆盖 —— 与 `tasks.ts` 的 Fencing 同一思路。
 *
 * 这里的 CAS 是**承重的**，不是先读后写的装饰：期望状态直接编进
 * `updateMany` 的 WHERE，更新是否命中由数据库裁决。写成
 * 「先 `findUnique` 读状态 → 检查白名单 → 裸 `update({ where: { id } })`」
 * 的话，两个写入者都能读到旧状态，后写的那个会把前一个的结果覆盖掉
 * （终态被改回去且毫无声音）。
 *
 * ── 为什么工具函数用 `updateMany` 而不是 `update({ where: { id, status } })` ──
 * 后者在条件不命中时抛 Prisma 的 P2025，既会往测试/生产日志里打
 * `prisma:error`，也只给得出「记录不存在」这种误导性描述。`updateMany`
 * 返回 `count`，把「没命中」变成一个可编程的事实，再由我们读一次当前状态，
 * 区分「重复提交（幂等）」与「真冲突（非法转移）」。
 *
 * ── 写边界先 parse ──
 * 与 `timeline.ts` 同一条口径：`parseActionPayload` 在**碰数据库之前**跑完，
 * 被拒绝的提案连一行都不会留下。它抛两种错误，性质不同、上层处理也不同：
 * - 类型**尚未接入** ⇒ `ValidationError`（文案含「尚未接入」）
 * - 已接入但 payload **形状不合法** ⇒ `ZodError`（由 `errors.ts` 的
 *   `toSvhError` 在 API 层归一为 VALIDATION_FAILED / 400）
 * 因此调用方（路由层）不能只 `instanceof ValidationError` 分支，否则后者漏成 500。
 */
import {
  assertDirectorActionTransition,
  parseActionPayload,
  requiresConfirmation,
} from '@svh/domain';
import type { DirectorActionStatus, DirectorActionType } from '@svh/domain';

import { prisma, type Prisma } from './client.js';

/** 动作读模型：逐列映射，不含 `createdAt` / `updatedAt`（见 `toRow`） */
export interface DirectorActionRow {
  id: string;
  projectId: string;
  contentId: string | null;
  sessionId: string | null;
  actor: string;
  type: string;
  targets: unknown;
  changes: Record<string, unknown>;
  status: string;
  requiresConfirmation: boolean;
  batchSize: number;
  confirmedAt: Date | null;
  executedAt: Date | null;
  result: unknown;
  errorMessage: string | null;
}

/** `director_actions` 的原始行（只列读模型用得到的列，不依赖 Prisma 的全部字段） */
interface DirectorActionDbRow {
  id: string;
  projectId: string;
  contentId: string | null;
  sessionId: string | null;
  actor: string;
  type: string;
  targets: unknown;
  changes: unknown;
  status: string;
  requiresConfirmation: boolean;
  batchSize: number;
  confirmedAt: Date | null;
  executedAt: Date | null;
  result: unknown;
  errorMessage: string | null;
}

/**
 * 显式逐列映射，不写 `{ ...row }`。
 *
 * Prisma 的行还带 `createdAt` / `updatedAt`，展开会让它们漏进返回值 ——
 * 读模型的形状由接口说了算，不由 Prisma 说了算（与 `timeline.ts` 的
 * `toClipRow` 同一条口径）。
 */
function toRow(row: DirectorActionDbRow): DirectorActionRow {
  return {
    id: row.id,
    projectId: row.projectId,
    contentId: row.contentId,
    sessionId: row.sessionId,
    actor: row.actor,
    type: row.type,
    targets: row.targets,
    // `changes` 是 Json 列（默认 `{}`）：空值统一归一为空对象
    changes: (row.changes ?? {}) as Record<string, unknown>,
    status: row.status,
    requiresConfirmation: row.requiresConfirmation,
    batchSize: row.batchSize,
    confirmedAt: row.confirmedAt,
    executedAt: row.executedAt,
    result: row.result,
    errorMessage: row.errorMessage,
  };
}

export interface CreateActionInput {
  projectId: string;
  contentId?: string;
  sessionId?: string;
  actor: 'user' | 'agent';
  type: DirectorActionType;
  payload: unknown;
}

/**
 * 落库一个动作提案。
 *
 * `requiresConfirmation` **不在入参里**：它由 `requiresConfirmation()` 从
 * 动作类型、目标数量与 `changes.overwrite` 推导。调用方（含 AI）即使多传一个
 * 同名字段也不会被读取 —— 这个值一旦可以由调用方指定，迟早会被填成 `false`。
 *
 * `status` 随之推导：需要确认的落 `awaiting_confirmation`，否则直接 `approved`
 * （`proposed` 只用于「提案已生成但尚未判定」的中间态，本仓储不产生它）。
 */
export async function createAction(input: CreateActionInput): Promise<DirectorActionRow> {
  const { targets, changes } = parseActionPayload(input.type, input.payload);
  const needsConfirmation = requiresConfirmation({ type: input.type, targets, changes });

  const created = await prisma.directorAction.create({
    data: {
      projectId: input.projectId,
      ...(input.contentId !== undefined ? { contentId: input.contentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      actor: input.actor,
      type: input.type,
      targets: targets as Prisma.InputJsonValue,
      changes: changes as Prisma.InputJsonValue,
      status: needsConfirmation ? 'awaiting_confirmation' : 'approved',
      requiresConfirmation: needsConfirmation,
      batchSize: targets.length,
    },
  });
  return toRow(created);
}

export async function getAction(id: string): Promise<DirectorActionRow> {
  return toRow(await prisma.directorAction.findUniqueOrThrow({ where: { id } }));
}

export async function listActions(
  projectId: string,
  filter: { status?: DirectorActionStatus } = {},
): Promise<DirectorActionRow[]> {
  const rows = await prisma.directorAction.findMany({
    where: { projectId, ...(filter.status !== undefined ? { status: filter.status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRow);
}

/** 一次状态推进的规格：入口白名单、目标状态与附带写入 */
interface TransitionSpec {
  /** 操作名，只进错误文案（日志里要能看出是哪个入口失败） */
  operation: string;
  /** 允许的来源状态：库中状态不在其中，CAS 就不会命中 */
  from: readonly DirectorActionStatus[];
  to: DirectorActionStatus;
  data?: Prisma.DirectorActionUpdateManyMutationInput;
}

/**
 * CAS 未命中后的判定：读到的当前状态决定「幂等」还是「报错」。
 *
 * 三种情况分开处理，因为调用方要做的事完全不同：
 * - 已经处在目标状态 ⇒ 重复提交，返回既有行（**不覆盖** `confirmedAt` / `result`）
 * - 状态机不允许这次转移 ⇒ 非法转移，带动作 id 与前后状态抛错
 * - 状态机允许、但本次操作的入口不认这个来源 ⇒ 前置状态不满足（兜底）
 *
 * 兜底那条今天仍可达：`proposed → approved` 在状态机里合法，而 `confirmAction`
 * 只处理「待确认」与「失败后重批」两种入口（本仓储不产生 `proposed` 行，
 * 但列默认值就是它，别的写入方可以产生）。将来新增入口时，这条兜底会给出
 * 可诊断的错误，而不是靠 `from` 集合与状态机「恰好对齐」来静默放行。
 */
function resolveCasMiss(
  id: string,
  current: DirectorActionDbRow,
  spec: TransitionSpec,
): DirectorActionRow {
  const currentStatus = current.status;

  if (currentStatus === spec.to) {
    return toRow(current);
  }

  try {
    assertDirectorActionTransition(currentStatus, spec.to);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `动作 ${id} 状态推进失败（当前 ${currentStatus}）：${reason}`,
      { cause: error },
    );
  }

  throw new Error(
    `动作 ${id} 当前状态为 ${currentStatus}，${spec.operation} 不接受该状态` +
      `（要求状态：${spec.from.join(' / ')}）`,
  );
}

/**
 * 推进动作状态：CAS 写入 + 白名单兜底。
 *
 * 先尝试条件更新，命中即成功；未命中才去读当前状态做判定（见 `resolveCasMiss`）。
 * 读只发生在**失败路径**上，所以正常流程里没有「读到的状态」这种可能过期的中间量。
 */
async function transition(id: string, spec: TransitionSpec): Promise<DirectorActionRow> {
  const { count } = await prisma.directorAction.updateMany({
    where: { id, status: { in: [...spec.from] } },
    data: { status: spec.to, ...spec.data },
  });

  if (count > 0) {
    // `updateMany` 不回传行，命中后再读一次拿完整数据（写入已提交，读到的必然是刚写的结果）
    return toRow(await prisma.directorAction.findUniqueOrThrow({ where: { id } }));
  }

  const current = await prisma.directorAction.findUniqueOrThrow({ where: { id } });
  return resolveCasMiss(id, current, spec);
}

/**
 * 用户批准一个动作（重复批准幂等）。
 *
 * 前置状态包含 `failed`：领域状态机明确允许 `failed → approved`
 * （「失败的动作允许在用户重新批准后重试」）。仓储层必须给出这条入口，
 * 否则就成了「领域允许、数据层做不到」—— 一个失败的批量删除永远没法重试。
 * 重新批准会**写入新的** `confirmedAt`（这是一次新的批准），
 * 与「已经 approved 时重复提交」的幂等路径不是同一回事。
 */
export async function confirmAction(id: string): Promise<DirectorActionRow> {
  return transition(id, {
    operation: 'confirmAction',
    from: ['awaiting_confirmation', 'failed'],
    to: 'approved',
    data: { confirmedAt: new Date() },
  });
}

/** 用户拒绝一个待确认的动作；`reason` 落进 `errorMessage` 供界面回显 */
export async function rejectAction(id: string, reason?: string): Promise<DirectorActionRow> {
  return transition(id, {
    operation: 'rejectAction',
    from: ['awaiting_confirmation', 'failed'],
    to: 'rejected',
    ...(reason !== undefined ? { data: { errorMessage: reason } } : {}),
  });
}

/** 执行器接管：`approved → executing` */
export async function markExecuting(id: string): Promise<DirectorActionRow> {
  return transition(id, { operation: 'markExecuting', from: ['approved'], to: 'executing' });
}

/**
 * 执行完成，回写派生任务：`executing → executed`。
 *
 * `result` 的形状按 `{ taskIds: string[], summary?: string }` 约定（见 schema 注释），
 * 但这里不收窄类型：回写内容由执行层决定，仓储只负责状态与时间戳的原子写入。
 */
export async function markExecuted(id: string, result: unknown): Promise<DirectorActionRow> {
  return transition(id, {
    operation: 'markExecuted',
    from: ['executing'],
    to: 'executed',
    data: { result: result as Prisma.InputJsonValue, executedAt: new Date() },
  });
}

/** 执行失败：`executing → failed`（终态 `executed` 之后不会再被改写成 failed） */
export async function markFailed(id: string, errorMessage: string): Promise<DirectorActionRow> {
  return transition(id, {
    operation: 'markFailed',
    from: ['executing'],
    to: 'failed',
    data: { errorMessage },
  });
}
