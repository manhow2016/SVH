/**
 * API 侧的任务服务
 *
 * 职责：把「用户点击执行技能」变成「创建任务 + 入队」，并立即返回。
 *
 * ── 为什么 API 不做任何执行 ──
 * 技术文档第 42 条：**Agent 不允许阻塞 HTTP 请求**。
 * AI 任务可能跑数分钟，因此 API 只创建任务记录并入队，然后立刻返回 202；
 * 真正的执行在 Worker 中，前端通过轮询或 SSE 获取进度。
 *
 * ── 队列连接的生命周期 ──
 * 队列池在进程内复用（含 Redis 连接），由 apps/api 的启动/关闭流程管理。
 * 这里用一个惰性单例持有它，避免每个请求都新建连接。
 */
import { getEnv } from '@svh/config';
import { createTask, prisma, type CreateTaskResult } from '@svh/database';
import type { TaskQueueName } from '@svh/domain';
import { createTaskQueuePool, type TaskQueuePool } from '@svh/queue';
import { getSkill } from '@svh/skills';

import { publishSessionEvent } from './events.js';

/** 队列池单例 */
let queuePool: TaskQueuePool | null = null;

/** 取出（必要时创建）队列池 */
export function getQueuePool(): TaskQueuePool {
  if (queuePool === null) {
    queuePool = createTaskQueuePool(getEnv().REDIS_URL, getEnv().QUEUE_PREFIX);
  }
  return queuePool;
}

/** 关闭队列连接（进程退出前调用） */
export async function closeQueuePool(): Promise<void> {
  if (queuePool !== null) {
    await queuePool.close();
    queuePool = null;
  }
}

/** 创建任务并入队的结果 */
export interface EnqueueResult extends CreateTaskResult {
  /** 任务状态（新建时为 pending；命中幂等时可能已是 running/success） */
  status: string;
}

/** 生成幂等键：同一技能 + 同一输入 + 同一内容，在短时间内只执行一次 */
export function buildIdempotencyKey(input: {
  skillId: string;
  projectId: string;
  contentId?: string | null;
  /** 由调用方提供的稳定标识；未提供时用输入的哈希 */
  explicit?: string | null;
  payload?: Record<string, unknown>;
}): string {
  if (input.explicit !== undefined && input.explicit !== null && input.explicit.length > 0) {
    return input.explicit;
  }

  // 用输入的稳定序列化做哈希：同样的请求体 → 同样的键 → 防重复提交
  const stable = stableStringify(input.payload ?? {});
  let hash = 0x811c9dc5;
  for (let i = 0; i < stable.length; i += 1) {
    hash ^= stable.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `${input.skillId}:${input.contentId ?? '-'}:${hash.toString(36)}`;
}

/** 稳定序列化：对键排序，保证同样的对象产生同样的字符串 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * 创建任务并入队。
 *
 * 顺序很重要：**先创建任务记录，再入队**。
 * 反过来的话，Worker 可能在任务记录落库前就取到作业，导致「作业找不到任务」。
 */
export async function enqueueSkillTask(input: {
  skillId: string;
  projectId: string;
  input: Record<string, unknown>;
  contentId?: string | null;
  sessionId?: string | null;
  idempotencyKey?: string | null;
  /** 初始状态；`waiting_user` 表示先落库、等用户确认后再入队 */
  initialStatus?: 'pending' | 'waiting_user';
}): Promise<EnqueueResult> {
  const catalogEntry = getSkill(input.skillId);
  if (!catalogEntry) {
    throw new Error(`技能 ${input.skillId} 不在目录中`);
  }

  const queueName: TaskQueueName = catalogEntry.queue;

  const created = await createTask({
    projectId: input.projectId,
    skillId: input.skillId,
    queueName,
    input: input.input,
    contentId: input.contentId ?? null,
    sessionId: input.sessionId ?? null,
    risk: catalogEntry.definition.risk,
    idempotencyKey: input.idempotencyKey ?? null,
    ...(input.initialStatus !== undefined ? { initialStatus: input.initialStatus } : {}),
  });

  // 幂等命中时任务可能已在执行或已完成，不必重复入队；
  // waiting_user 的任务必须等用户确认，这里**不得**入队
  if (!created.deduplicated && input.initialStatus !== 'waiting_user') {
    await getQueuePool().enqueue({
      taskId: created.taskId,
      queueName: created.queueName,
      attempt: 1,
    });
  }

  const task = await prisma.agentTask.findUnique({
    where: { id: created.taskId },
    select: { status: true },
  });

  return { ...created, status: task?.status ?? 'pending' };
}

/** 一次确认的结果：放行了哪些、跳过了哪些以及各自的原因 */
export interface ConfirmTasksResult {
  resumed: string[];
  skipped: Array<{ taskId: string; reason: string }>;
}

/**
 * 放行一批停在 `waiting_user` 的任务。
 *
 * ── 为什么抽成共用函数 ──
 * 这个状态需要**两条**入口，而放行逻辑（CAS + 入队 + 广播）必须完全一致：
 *   · `POST /api/agent/sessions/:id/confirm` —— 用户在对话里点「确认执行」；
 *   · `POST /api/tasks/:id/confirm` —— 任务级出口，给没有会话的任务用。
 * 复制一份 CAS 是这类「批准凭据」代码最危险的写法：漏写 `confirmedAt` 就会
 * 让任务在「入队 → 撞闸门 → waiting_user」之间无限循环，而两份实现里
 * 只要有一份写对了，测试就可能只覆盖到那一份。
 *
 * 调用方负责先把 taskId 解析出来（会话级要按 sessionId 查一遍），
 * 这里只处理「给定 id 列表 → 尽量放行」。
 */
export async function confirmTasks(taskIds: readonly string[]): Promise<ConfirmTasksResult> {
  const resumed: string[] = [];
  const skipped: Array<{ taskId: string; reason: string }> = [];

  for (const taskId of taskIds) {
    const task = await prisma.agentTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        queueName: true,
        sessionId: true,
      },
    });

    if (task === null) {
      skipped.push({ taskId, reason: '任务不存在' });
      continue;
    }
    if (task.status !== 'waiting_user') {
      skipped.push({ taskId, reason: `任务当前状态是「${task.status}」，不需要确认` });
      continue;
    }
    if (task.queueName === null) {
      skipped.push({ taskId, reason: '任务缺少队列信息' });
      continue;
    }
    if (task.attempts >= task.maxAttempts) {
      skipped.push({ taskId, reason: '尝试次数已耗尽' });
      continue;
    }

    /*
     * 状态从 waiting_user 回到 pending，使其重新可被抢占。
     * `confirmedAt` 必须与状态写在**同一次**更新里：它是「用户已批准」的
     * 唯一凭据，Worker 据此放行本次执行；漏写会让任务再次退回 waiting_user，
     * 用户点了确认却永远等不到结果。也只在这里写入 —— 其它路径不得伪造批准。
     */
    const granted = await prisma.agentTask.updateMany({
      where: { id: task.id, status: 'waiting_user' },
      data: {
        status: 'pending',
        confirmedAt: new Date(),
        progress: 0,
        progressMessage: null,
        error: null,
        errorMessage: null,
      },
    });

    /*
     * CAS 落空说明任务已不是 waiting_user（并发确认、用户取消、Worker 抢先），
     * 本次确认什么都没写成。此时刻意不入队、不广播、不计入 resumed：
     * 广播 pending 与回复「已确认 N 个操作」都会产出数据库中并不存在的状态，
     * 正是本仓库一律拒绝的「看似成功的失败」。跳过原因如实交代。
     */
    if (granted.count !== 1) {
      skipped.push({ taskId: task.id, reason: '任务状态已变化，确认未生效' });
      continue;
    }

    await getQueuePool().enqueue({
      taskId: task.id,
      queueName: task.queueName,
      attempt: task.attempts + 1,
    });

    // 广播状态变化，使用户立刻看到任务从「待确认」变为「排队中」。
    // 没有会话的任务（任务级端点建的）没有广播对象，跳过即可 —— 但状态已经落库，
    // 前端轮询同样能看到。
    if (task.sessionId !== null) {
      await publishSessionEvent(task.sessionId, 'task.status', {
        taskId: task.id,
        status: 'pending',
      });
    }

    resumed.push(task.id);
  }

  return { resumed, skipped };
}

/** 重新入队一个任务（用于重试被取消或卡住的任务） */
export async function requeueTask(taskId: string): Promise<{ enqueued: boolean; reason?: string }> {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, attempts: true, maxAttempts: true, queueName: true },
  });
  if (!task) return { enqueued: false, reason: '任务不存在' };
  if (task.status === 'running') return { enqueued: false, reason: '任务正在执行中' };
  if (task.status === 'success') return { enqueued: false, reason: '任务已成功完成' };
  // waiting_user 表示任务正卡在确认闸门后等待用户批准。重试**不是**批准的等价物：
  // 它不写 `confirmedAt`，置回 pending 只会让 Worker 再次把任务退回 waiting_user，
  // 用户看到「重试 → 又回到待确认」，还白白消耗一次尝试次数（修复前的原症状）。
  // 唯一的放行出口是确认接口（会话级 `POST /api/agent/sessions/:id/confirm`
  // 与任务级 `POST /api/tasks/:id/confirm`，两者共用下面的 confirmTasks）。
  if (task.status === 'waiting_user') {
    return { enqueued: false, reason: '任务正在等待用户确认，请通过确认接口放行' };
  }
  if (task.queueName === null) return { enqueued: false, reason: '任务缺少队列信息' };
  if (task.attempts >= task.maxAttempts) {
    return { enqueued: false, reason: '任务的尝试次数已耗尽' };
  }

  const nextAttempt = task.attempts + 1;

  // 把状态重置为 pending 并清空错误，使其可被重新抢占。
  // 白名单刻意**不含** `waiting_user`（它已在上面提前返回）：CAS 只认「已经跑完
  // 一轮」的状态，确认闸门后的等待不属于可重试状态。
  const reset = await prisma.agentTask.updateMany({
    where: { id: taskId, status: { in: ['failed', 'cancelled', 'pending'] } },
    data: { status: 'pending', error: null, errorMessage: null, progress: 0, progressMessage: null },
  });

  // CAS 落空说明状态在读取与写入之间被改掉了（并发取消 / Worker 抢占等）。
  // 此时不能入队：那会换来一次注定被跳过的出队，接口还会返回「已重试」的假成功。
  if (reset.count !== 1) {
    return { enqueued: false, reason: '任务状态已变化，请刷新后重试' };
  }

  await getQueuePool().enqueue({ taskId, queueName: task.queueName, attempt: nextAttempt });
  return { enqueued: true };
}
