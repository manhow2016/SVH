/**
 * 任务运行时契约
 *
 * 本文件承载 Phase 0 审计得出的关键设计结论，是 SVH 任务系统必须遵守的规则。
 *
 * ── 审计结论 ①：重试必须在「领域层」而非「队列层」 ──
 * BullMQ 的 `attempts` 恒为 1，真正的重试由领域层控制，并把重试时间写进
 * Outbox 事件。原因有两个，都是硬性的：
 *   1. 只有领域层重试才能**在重试前切换模型**（Model A 失败 → Model B）；
 *   2. 只有领域层重试才能让「重试计数」与「状态回写」在**同一事务内**提交，
 *      避免出现「计数加了但状态没改」的不一致。
 *
 * ── 审计结论 ②：幂等三件套，缺一不可 ──
 *   1. DB 唯一键：`@@unique([projectId, idempotencyKey])`
 *   2. 确定性 jobId：`task-{taskId}-attempt-{n}`（可推导，重放时命中同一作业）
 *   3. CAS 闸门：`updateMany where { taskId: null }` 抢占式写入
 * 三层叠加才能同时防住「用户重复点击」「事件重放」「多 Worker 竞争」。
 *
 * ── 审计结论 ③：Fencing —— 所有终态写入必须带租约令牌 ──
 * Worker 可能因 GC / 网络分区在失去租约后仍继续执行。因此任务终态写入
 * 必须携带 `leaseVersion` + `workerId` 做 CAS，版本不匹配即拒绝，
 * 防止旧 Worker 覆盖新 Worker 的结果。
 */
import { z } from 'zod';
import { EXECUTION_STATUSES, TASK_STATUSES } from './enums.js';
import { idSchema } from './common.js';

/** 任务状态（复用 enums.ts 的单一来源） */
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatusValue = z.infer<typeof taskStatusSchema>;

/** 执行状态（任务步骤 / Skill 执行 / 单次尝试共用） */
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatusValue = z.infer<typeof executionStatusSchema>;

/**
 * 任务状态机转移白名单。
 *
 * 用 `satisfies` 保证「新增状态却忘记补转移规则」变成**编译错误**，
 * 而不是运行时的静默异常。
 *
 * 审计提醒：这份白名单必须**真正接进执行路径**（写状态前统一校验），
 * 否则它只是一份文档。
 */
export const TASK_TRANSITIONS = {
  pending: ['running', 'waiting_user', 'cancelled', 'failed'],
  running: [
    // 正常收敛
    'success',
    'failed',
    'waiting_user',
    'cancelled',
    /*
     * `running → running`：租约过期后被另一个 Worker 接管。
     *
     * 这是**允许的自我转移**而不是重复执行：原 Worker 已失去租约
     * （心跳续约失败会触发 abort），新 Worker 从 attempts 计数继续。
     * 并发安全由 claimTask 的 CAS 保证 —— 它要求 status 与 attempts
     * 都与读取时一致才更新，因此两个 Worker 不可能同时抢到。
     * 旧 Worker 即便继续执行，其写入也会被 Fencing 拒绝。
     */
    'running',
    /*
     * `running → pending`：本次尝试失败但仍有尝试预算，等待下一次抢占。
     *
     * 这是「领域层重试」的核心转移：状态回到 pending 并释放租约，
     * 由延迟作业重新入队后再次抢占。之所以不用 running 保持等待，
     * 是因为 pending 能明确表达「当前没有 Worker 持有它」。
     */
    'pending',
  ],
  waiting_user: ['running', 'cancelled', 'failed'],
  // 终态：不可再转移（重试通过新的 attempt 实现，见上面的 running → pending）
  success: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<TaskStatusValue, readonly TaskStatusValue[]>;

/** 判断状态转移是否合法 */
export function canTransitionTask(from: TaskStatusValue, to: TaskStatusValue): boolean {
  return (TASK_TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * 断言状态转移合法，非法时抛错。
 * 执行路径必须在写库前调用它 —— 这是白名单真正生效的地方。
 */
export function assertTaskTransition(from: TaskStatusValue, to: TaskStatusValue): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`非法的任务状态转移：${from} → ${to}`);
  }
}

/** 判断是否为终态 */
export function isTerminalStatus(status: TaskStatusValue): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}

/**
 * 任务资源池（队列）。
 *
 * 审计结论：**不要用单队列混跑所有类型** —— 数分钟级的视频/渲染任务
 * 会占满并发槽位，把秒级的文本任务饿死。
 * 因此按资源特性分池，每个池独立设置并发与限流。
 *
 * 命名使用下划线而非点号，以便与 Prisma 枚举取值保持字面一致
 * （Prisma 枚举值不允许包含 `.`），从而让枚举漂移测试可以做等值比对。
 */
export const TASK_QUEUES = [
  /** 文本 / 剧本 / 结构化输出 */
  'ai_llm',
  /** 图片生成与编辑 */
  'ai_image',
  /** 视频生成、延长 */
  'ai_video',
  /** 音频 / 配音 / 音乐 */
  'ai_audio',
  /** 数字人合成 */
  'ai_digital_human',
  /** 字幕 / 剪辑 / 合成等本地计算 */
  'ai_render',
  /** 轻量资产操作（创建 / 更新 / 引用同步） */
  'asset',
] as const;
export type TaskQueueName = (typeof TASK_QUEUES)[number];
export const taskQueueNameSchema = z.enum(TASK_QUEUES);

/**
 * 各资源池的默认并发。
 * 视频与数字人合成受 Provider 限流约束最强，因此并发最低；
 * 文本任务几乎不受限，可给较高并发。
 */
export const TASK_QUEUE_CONCURRENCY: Record<TaskQueueName, number> = {
  ai_llm: 8,
  ai_image: 4,
  ai_video: 2,
  ai_audio: 4,
  ai_digital_human: 2,
  ai_render: 2,
  asset: 8,
};

/** 各资源池的默认超时（毫秒），超过则判定 TASK_TIMEOUT */
export const TASK_QUEUE_TIMEOUT_MS: Record<TaskQueueName, number> = {
  ai_llm: 180_000,
  ai_image: 300_000,
  ai_video: 1_800_000,
  ai_audio: 300_000,
  ai_digital_human: 1_800_000,
  ai_render: 1_800_000,
  asset: 60_000,
};

/**
 * 确定性 jobId。
 *
 * 采用「任务 id + 尝试序号」而非随机值：事件重放时能命中同一个 BullMQ 作业，
 * 从而天然去重（BullMQ 对相同 jobId 的重复添加会返回已有作业）。
 */
export function buildJobId(taskId: string, attempt: number): string {
  return `task-${taskId}-attempt-${attempt}`;
}

/** 从 jobId 反解任务 id 与尝试序号（对账与排查用） */
export function parseJobId(jobId: string): { taskId: string; attempt: number } | null {
  const match = /^task-(.+)-attempt-(\d+)$/.exec(jobId);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { taskId: match[1], attempt: Number.parseInt(match[2], 10) };
}

/* -------------------------------------------------------------------------- */
/* 租约与执行尝试                                                              */
/* -------------------------------------------------------------------------- */

/** 租约默认时长（毫秒）：Worker 需在此时间内续约，否则任务被回收 */
export const DEFAULT_LEASE_MS = 120_000;

/** 心跳间隔（毫秒），应显著小于租约时长 */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * 任务租约。
 * 持久化在 task_leases 表（独立于 agent_tasks，避免任务表膨胀成上帝表）。
 */
export const taskLeaseSchema = z.object({
  taskId: idSchema,
  workerId: z.string().min(1).max(128),
  leaseUntil: z.date(),
  /** 单调递增的 fencing 令牌 */
  leaseVersion: z.number().int().positive(),
  heartbeatAt: z.date(),
});

export type TaskLease = z.infer<typeof taskLeaseSchema>;

/**
 * 单次执行尝试的审计记录。
 * 是成本归因、失败分析与「重试前切换模型」可追溯性的数据基础。
 */
export const taskAttemptSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  /** 从 1 开始 */
  attempt: z.number().int().positive(),
  status: z.enum(['pending', 'running', 'success', 'failed', 'cancelled']),
  /** 本次尝试实际使用的模型与 Provider —— 降级时每次不同 */
  modelId: z.string().max(128).nullable().optional(),
  providerId: idSchema.nullable().optional(),
  workerId: z.string().max(128).nullable().optional(),
  /** 本次尝试持有的 fencing 令牌 */
  leaseVersion: z.number().int().positive().nullable().optional(),
  error: z.string().max(5000).nullable().optional(),
  usage: z.record(z.string(), z.unknown()).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  startedAt: z.date(),
  finishedAt: z.date().nullable().optional(),
});

export type TaskAttempt = z.infer<typeof taskAttemptSchema>;

/**
 * Fencing 写入条件。
 *
 * 约定：任何任务终态写入都必须构造该条件并在 SQL 层做 CAS，
 * 只有「租约版本 + Worker 身份」都匹配时才允许写。
 */
export interface FencingToken {
  taskId: string;
  workerId: string;
  leaseVersion: number;
}

/** 判断某次写入是否持有有效租约（供仓储层构造 where 条件） */
export function matchesFencing(
  lease: Pick<TaskLease, 'workerId' | 'leaseVersion'>,
  token: Pick<FencingToken, 'workerId' | 'leaseVersion'>,
): boolean {
  return lease.workerId === token.workerId && lease.leaseVersion === token.leaseVersion;
}

/** 租约是否已过期 */
export function isLeaseExpired(lease: Pick<TaskLease, 'leaseUntil'>, now: Date = new Date()): boolean {
  return lease.leaseUntil.getTime() <= now.getTime();
}
