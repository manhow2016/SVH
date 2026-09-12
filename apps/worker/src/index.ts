/**
 * SVH Worker 进程入口
 *
 * 职责：
 * 1. 装配 Skill 依赖（数据库端口 + Model Router）与执行器
 * 2. 为每个资源池启动 BullMQ Worker
 * 3. 运行**对账循环**：回收租约过期的任务（审计结论 ⑨）
 * 4. 优雅关闭：停止消费 → 等待在途任务 → 关闭队列与数据库
 *
 * ── 为什么必须有对账循环 ──
 * Worker 可能被 kill -9、容器可能被驱逐、进程可能 OOM。
 * 这些情况下任务会停在 running 且租约永不释放，变成「僵尸任务」。
 * 对账循环负责把它们重新置为 pending 并重新入队。
 */
import { bootstrapConfig, EnvValidationError } from '@svh/config';
import {
  buildModelRuntime,
  disconnectPrisma,
  prisma,
  reclaimExpiredTasks,
} from '@svh/database';
import {
  closeWorkerGracefully,
  createTaskQueuePool,
  createTaskWorker,
  getQueueDepths,
  type TaskJobResult,
  type TaskQueuePool,
} from '@svh/queue';
import { createDefaultSkillRegistry, type SkillLogger } from '@svh/skills';
import { TASK_QUEUES, type TaskQueueName } from '@svh/domain';

import { buildSkillDeps } from './deps.js';
import { TaskRunner } from './runner.js';

/** 对账循环间隔：1 分钟足够及时，又不会给数据库造成压力 */
const RECONCILE_INTERVAL_MS = 60_000;

/** 优雅关闭时等待在途任务的上限 */
const SHUTDOWN_GRACE_MS = 60_000;

/** 生成 Worker 标识：hostname + pid，便于在租约表中定位是哪个进程 */
function resolveWorkerId(configured?: string): string {
  if (configured !== undefined && configured.length > 0) return configured;
  const host = process.env.HOSTNAME ?? 'local';
  return `worker-${host}-${process.pid}`;
}

/** 构造结构化日志器（不引入日志库，与 API 的 pino 解耦） */
function createLogger(level: string): SkillLogger {
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const threshold = levels.indexOf(level);

  const shouldLog = (l: string): boolean => levels.indexOf(l) >= threshold;

  const emit = (l: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown): void => {
    if (!shouldLog(l)) return;
    const line = JSON.stringify({
      level: l,
      time: new Date().toISOString(),
      component: 'worker',
      msg,
      ...(meta !== undefined ? { meta: sanitize(meta) } : {}),
    });
    if (l === 'error' || l === 'warn') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

/** 日志脱敏：避免密钥以明文进入日志 */
function sanitize(meta: unknown): unknown {
  if (meta === null || typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) return meta.map(sanitize);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    result[key] =
      /key|token|secret|password|authorization/i.test(key) ? '[已脱敏]' : sanitize(value);
  }
  return result;
}

async function main(): Promise<void> {
  // ① 配置（fail-fast）
  let env;
  try {
    env = bootstrapConfig().env;
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`\n[SVH Worker] 启动失败：环境变量配置不正确\n\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(env.LOG_LEVEL);
  const workerId = resolveWorkerId(env.WORKER_ID);

  logger.info('Worker 启动中', {
    workerId,
    nodeEnv: env.NODE_ENV,
    modelProviderMode: env.MODEL_PROVIDER_MODE,
  });

  // ② 装配 Model Router 与技能
  const modelRuntime = await buildModelRuntime({
    encryptionKey: env.SECRET_ENCRYPTION_KEY,
    mode: env.MODEL_PROVIDER_MODE,
    logger: {
      info: (msg, meta) => logger.info(msg, meta),
      warn: (msg, meta) => logger.warn(msg, meta),
    },
  });

  logger.info('模型运行时已装配', {
    providers: modelRuntime.providers.length,
    models: modelRuntime.models.length,
    usingMock: modelRuntime.usingMock,
  });

  const registry = createDefaultSkillRegistry();
  const stats = registry.stats();
  logger.info('技能注册表已装载', {
    total: stats.total,
    implemented: stats.implemented,
    pending: stats.pending.length,
  });

  const deps = buildSkillDeps({ router: modelRuntime.router, models: modelRuntime.models });

  // ③ 队列与运行器
  // 运行器在每次作业开始时自行构造执行器（见 runner.ts 的说明），
  // 因此这里只需把注册表、依赖与队列交给它。
  const queues: TaskQueuePool = createTaskQueuePool(env.REDIS_URL);
  const runner = new TaskRunner({
    registry,
    deps,
    queues,
    workerId,
    logger,
    // Worker 遇到高成本技能时置为 waiting_user，等待用户确认后再执行
    confirmationPolicy: 'reject',
  });

  // ④ 启动各资源池 Worker
  const workers = TASK_QUEUES.map((queueName: TaskQueueName) =>
    createTaskWorker({
      redisUrl: env.REDIS_URL,
      queueName,
      workerId,
      handler: async (job): Promise<TaskJobResult> => runner.handleJob(job.data),
    }),
  );

  logger.info(`已启动 ${workers.length} 个资源池消费者`, {
    queues: TASK_QUEUES.join(', '),
  });

  // ⑤ 对账循环
  const reconcileTimer = setInterval(() => {
    void (async () => {
      const reclaimed = await reclaimExpiredTasks();
      if (reclaimed.length === 0) return;

      logger.warn(`对账：回收 ${reclaimed.length} 个租约过期的任务`);

      // 回收后重新入队，让任务能被再次抢占
      for (const taskId of reclaimed) {
        const task = await prisma.agentTask.findUnique({
          where: { id: taskId },
          select: { attempts: true, maxAttempts: true, queueName: true, status: true },
        });
        if (!task || task.status !== 'pending') continue;

        if (task.attempts >= task.maxAttempts) {
          logger.warn(`任务 ${taskId} 已耗尽尝试次数，标记为失败`);
          await prisma.agentTask.updateMany({
            where: { id: taskId, status: 'pending' },
            data: {
              status: 'failed',
              error: '租约多次过期，已放弃',
              errorMessage: '任务长时间没有进展，已停止重试，请重新发起。',
              finishedAt: new Date(),
            },
          });
          continue;
        }

        if (task.queueName === null) continue;
        await queues.enqueue({
          taskId,
          queueName: task.queueName,
          attempt: task.attempts + 1,
        });
      }
    })().catch((err: unknown) => {
      logger.error('对账循环异常', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  // 启动时立即对账一次：兜住上次进程崩溃遗留的僵尸任务
  void (async () => {
    const reclaimed = await reclaimExpiredTasks();
    if (reclaimed.length > 0) {
      logger.warn(`启动对账：发现 ${reclaimed.length} 个遗留的过期租约任务`);
    }
  })().catch(() => undefined);

  // ⑥ 优雅关闭
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`收到 ${signal}，开始优雅关闭`);

    const forceExit = setTimeout(() => {
      logger.error('优雅关闭超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS + 10_000);
    forceExit.unref();

    clearInterval(reconcileTimer);

    // 1) 中断在途任务：让技能有机会清理（而不是直接 kill）
    runner.abortAll('进程正在关闭');

    // 2) 停止消费，给在途任务留出收尾时间
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    await Promise.all(
      workers.map(async (worker) => {
        const remaining = Math.max(1000, deadline - Date.now());
        await closeWorkerGracefully(worker, remaining);
      }),
    );
    logger.info('队列消费者已关闭');

    // 3) 关闭队列连接与数据库
    await queues.close();
    await disconnectPrisma();

    clearTimeout(forceExit);
    logger.info('优雅关闭完成');
    process.exit(0);
  };

  // 用显式 catch 而不是 void 丢弃 Promise：
  // 关闭流程本身失败必须留下日志并退出，否则进程会卡在未定义状态。
  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal).catch((err: unknown) => {
      logger.error('关闭流程未预期失败', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常，进程即将退出', { error: err.message, stack: err.stack });
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    shutdown('unhandledRejection').catch(() => process.exit(1));
  });

  // 就绪日志：包含队列深度，便于确认 Worker 真的在消费
  const depths = await getQueueDepths(queues);
  logger.info('SVH Worker 已就绪', { queueDepths: depths });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[SVH Worker] 启动过程中发生未预期错误：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
