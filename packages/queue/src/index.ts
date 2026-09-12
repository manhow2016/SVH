/**
 * 任务队列（BullMQ 资源池）
 *
 * ── 核心设计：队列层不做重试 ──
 * 审计结论 ①：BullMQ 的 `attempts` **恒为 1**，重试完全由领域层控制。
 * 原因有两条，都是硬性的：
 *   1. 只有领域层重试才能在重试前**切换模型**（Model A 失败 → Model B）；
 *   2. 只有领域层重试才能让「重试计数」与「状态回写」在**同一事务内**提交。
 * 若交给 BullMQ 重试，它会绕过状态机直接重跑作业，造成状态与尝试记录脱节。
 *
 * ── 按资源池分队列 ──
 * 审计结论 ⑭：单队列混跑会让数分钟级的视频任务占满并发槽位，
 * 把秒级的文本任务饿死。因此每个资源池一个队列，各自独立并发与超时。
 *
 * ── 确定性 jobId ──
 * `task-{taskId}-attempt-{n}`。BullMQ 对相同 jobId 的重复添加会返回已有作业，
 * 因此事件重放天然去重 —— 这是幂等三件套的第二层。
 */
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';

import {
  buildJobId,
  TASK_QUEUES,
  TASK_QUEUE_CONCURRENCY,
  TASK_QUEUE_TIMEOUT_MS,
  type TaskQueueName,
} from '@svh/domain';

/** 队列作业负载：**只放 id**，不放业务数据 */
export interface TaskJobData {
  taskId: string;
  /** 第几次尝试（从 1 开始），用于日志与排查 */
  attempt: number;
}

/**
 * 队列负载刻意只包含 taskId。
 *
 * 审计结论：把业务输入塞进作业负载会导致「作业里的数据」与「数据库状态」
 * 两份事实来源，重试或延迟执行时二者可能已经不一致。
 * 正确做法是 Worker 拿到 id 后回数据库读取最新状态。
 */
export interface TaskJobResult {
  taskId: string;
  status: 'success' | 'failed' | 'retry_scheduled' | 'skipped';
  message?: string;
}

/** 队列集合的封装 */
export interface TaskQueuePool {
  /** 取某个资源池队列 */
  queue(name: TaskQueueName): Queue<TaskJobData, TaskJobResult>;
  /** 入队一个任务尝试 */
  enqueue(input: {
    taskId: string;
    queueName: TaskQueueName;
    attempt: number;
    /** 延迟执行（毫秒），领域层重试的退避时间写在这里 */
    delayMs?: number;
    /** 优先级，数值越小越优先 */
    priority?: number;
  }): Promise<string>;
  /** 关闭全部队列连接（进程退出前必须调用） */
  close(): Promise<void>;
}

/** 解析 Redis 连接串为 BullMQ 所需结构 */
export function parseRedisConnection(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
  username?: string;
} {
  const parsed = new URL(url);
  const dbSegment = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(dbSegment ? { db: Number.parseInt(dbSegment, 10) } : {}),
  };
}

/** 队列名前缀，避免与同一 Redis 库中其它项目的键冲突 */
const QUEUE_PREFIX = 'svh';

/**
 * 创建队列池。
 *
 * 注意：每个资源池一个 Queue 实例，但共享同一份连接配置。
 * BullMQ 内部为每个 Queue 维护独立连接，因此不要在这里自行复用 connection 对象
 * （阻塞式命令会互相干扰）。
 */
export function createTaskQueuePool(redisUrl: string): TaskQueuePool {
  const connection = parseRedisConnection(redisUrl);
  const queues = new Map<TaskQueueName, Queue<TaskJobData, TaskJobResult>>();

  const queue = (name: TaskQueueName): Queue<TaskJobData, TaskJobResult> => {
    const existing = queues.get(name);
    if (existing) return existing;

    const created = new Queue<TaskJobData, TaskJobResult>(name, {
      connection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        // 关键：队列层不重试，重试由领域层调度
        attempts: 1,
        // 已完成作业保留一段时间，便于排查；失败作业保留更久
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 5000 },
        // 失败后不自动回退重试
        backoff: undefined,
      },
    });
    queues.set(name, created);
    return created;
  };

  // 预创建全部资源池，使队列键在 Redis 中立即出现（便于运维观察）
  for (const name of TASK_QUEUES) queue(name);

  return {
    queue,

    async enqueue({ taskId, queueName, attempt, delayMs, priority }): Promise<string> {
      const jobId = buildJobId(taskId, attempt);
      const options: JobsOptions = {
        jobId,
        ...(delayMs !== undefined && delayMs > 0 ? { delay: delayMs } : {}),
        ...(priority !== undefined ? { priority } : {}),
      };

      // 相同 jobId 重复添加时 BullMQ 返回已有作业，天然去重
      const job = await queue(queueName).add('execute-task', { taskId, attempt }, options);
      return job.id ?? jobId;
    },

    async close(): Promise<void> {
      await Promise.all([...queues.values()].map((q) => q.close()));
      queues.clear();
    },
  };
}

/** Worker 创建选项 */
export interface CreateTaskWorkerOptions {
  redisUrl: string;
  queueName: TaskQueueName;
  /**
   * 作业处理器。由调用方（apps/worker）注入真实的任务执行逻辑，
   * 队列包本身不依赖数据库 —— 保持与 @svh/ai 相同的端口/适配器隔离原则。
   */
  handler: (job: Job<TaskJobData, TaskJobResult>) => Promise<TaskJobResult>;
  /** 覆盖并发（默认取资源池配置） */
  concurrency?: number;
  /** 覆盖超时（默认取资源池配置） */
  timeoutMs?: number;
  /** Worker 标识，用于租约与 Fencing */
  workerId: string;
}

/**
 * 创建一个资源池的 Worker。
 *
 * 超时策略：`lockDuration` 必须显著大于单步耗时，否则 BullMQ 会认为作业已死
 * 并重新投递，导致同一任务被并发执行两次。真正的单次调用超时由
 * Model Router 的 `timeoutMs` 与租约对账共同保证。
 */
export function createTaskWorker(options: CreateTaskWorkerOptions): Worker<TaskJobData, TaskJobResult> {
  const timeoutMs = options.timeoutMs ?? TASK_QUEUE_TIMEOUT_MS[options.queueName];
  const concurrency = options.concurrency ?? TASK_QUEUE_CONCURRENCY[options.queueName];

  const worker = new Worker<TaskJobData, TaskJobResult>(options.queueName, options.handler, {
    connection: parseRedisConnection(options.redisUrl),
    prefix: QUEUE_PREFIX,
    concurrency,
    // 略大于任务超时，避免长任务被误判为僵死
    lockDuration: Math.max(timeoutMs + 30_000, 60_000),
    // 每 15 秒续期一次锁，防止长任务在执行中丢失锁
    lockRenewTime: 15_000,
    // 单个作业的最大执行时间，超过则中断
    // 注意：这是最后的兜底，业务侧仍应通过 AbortSignal 主动响应取消
    // BullMQ 的 maxStalledCount 控制作业卡住后允许被重新投递的次数
    maxStalledCount: 1,
  });

  worker.on('failed', (job, err) => {
    // 这里只记录；真正的失败状态由 handler 内部的领域逻辑写入
    console.error(
      `[queue:${options.queueName}] 作业失败 worker=${options.workerId} jobId=${job?.id ?? 'unknown'}: ${err.message}`,
    );
  });

  worker.on('error', (err) => {
    console.error(`[queue:${options.queueName}] Worker 错误: ${err.message}`);
  });

  return worker;
}

/**
 * 优雅关闭：等待在途作业完成，但不超过给定时间。
 *
 * 审计结论 ⑬：worker.close() 必须带宽限期，否则在途的 AI 任务会被硬中断，
 * Provider 侧已经计费但结果丢失。
 */
export async function closeWorkerGracefully(
  worker: Worker<TaskJobData, TaskJobResult>,
  graceMs = 30_000,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, graceMs);

    worker
      .close()
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/** 查询各资源池的队列深度，供就绪探针与运维面板使用 */
export async function getQueueDepths(
  pool: TaskQueuePool,
): Promise<Record<string, { waiting: number; active: number; delayed: number; failed: number }>> {
  const result: Record<string, { waiting: number; active: number; delayed: number; failed: number }> = {};

  await Promise.all(
    TASK_QUEUES.map(async (name) => {
      const counts = await pool.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
      result[name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    }),
  );

  return result;
}
