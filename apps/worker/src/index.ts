/**
 * SVH Worker 进程入口
 *
 * 职责：
 * 1. 装配 Skill 依赖（数据库端口 + Model Router）与执行器
 * 2. 为每个资源池启动 BullMQ Worker
 * 3. 运行**对账循环**：回收租约过期的任务（审计结论 ⑨）
 * 4. 把任务状态、进度与资产变更经事件总线推送给 SSE 端点（发射后不管）
 * 5. 优雅关闭：停止消费 → 等待在途任务 → 关闭队列、事件连接与数据库
 *
 * ── 为什么必须有对账循环 ──
 * Worker 可能被 kill -9、容器可能被驱逐、进程可能 OOM。
 * 这些情况下任务会停在 running 且租约永不释放，变成「僵尸任务」。
 * 对账循环负责把它们重新置为 pending 并重新入队。
 */
import { bootstrapConfig, EnvValidationError } from '@svh/config';
import {
  buildModelRuntime,
  computeProviderConfigVersion,
  disconnectPrisma,
  needsRuntimeRefresh,
  prisma,
  probeAllProviders,
  reclaimExpiredTasks,
  refreshModelRuntime,
} from '@svh/database';
import {
  closeWorkerGracefully,
  createTaskQueuePool,
  createTaskWorker,
  getQueueDepths,
  parseRedisConnection,
  type TaskJobResult,
  type TaskQueuePool,
} from '@svh/queue';
import { createEventPublisher } from '@svh/realtime';
import { createDefaultSkillRegistry, type SkillLogger } from '@svh/skills';
import { TASK_QUEUES, type TaskQueueName } from '@svh/domain';

import { buildSkillDeps } from './deps.js';
import { createEventSink } from './events.js';
import { TaskRunner } from './runner.js';

/** 对账循环间隔：1 分钟足够及时，又不会给数据库造成压力 */
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * 模型服务配置的检测间隔。
 * 30 秒是个平衡点：用户改完配置后最多等半分钟生效，
 * 而查询只是两个轻量聚合。
 */
const CONFIG_REFRESH_INTERVAL_MS = 30_000;

/** 优雅关闭时等待在途任务的上限 */
const SHUTDOWN_GRACE_MS = 60_000;

/**
 * 对账放弃任务时写入数据库、并下发给用户的文案。
 *
 * 抽成常量是为了让「写库的 errorMessage」与「广播的 message」**同源**：
 * 两处各写一份字符串，迟早会漂移到「界面看到的失败原因不是数据库里那条」。
 */
const RECONCILE_GIVE_UP_MESSAGE = '任务长时间没有进展，已停止重试，请重新发起。';

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
  });

  // ② 装配 Model Router 与技能
  const modelRuntime = await buildModelRuntime({
    encryptionKey: env.SECRET_ENCRYPTION_KEY,
    logger: {
      info: (msg, meta) => logger.info(msg, meta),
      warn: (msg, meta) => logger.warn(msg, meta),
    },
  });

  logger.info('模型运行时已装配', {
    providers: modelRuntime.providers.length,
    models: modelRuntime.models.length,
    usingMock: modelRuntime.usingMock,
    adapterKinds: modelRuntime.adapterKinds,
  });

  // 启动时对真实 Provider 做一次探活：
  // 数据库里的 health 可能是上次进程留下的陈旧值，若沿用会让首批调用
  // 选中一个实际已不可用的 Provider。探活失败不阻断启动。
  if (!modelRuntime.usingMock) {
    try {
      const probes = await probeAllProviders({ encryptionKey: env.SECRET_ENCRYPTION_KEY });
      logger.info('Provider 探活完成', {
        total: probes.length,
        healthy: probes.filter((r) => r.health === 'healthy').length,
        unhealthy: probes.filter((r) => r.health !== 'healthy').map((r) => r.providerName),
      });
    } catch (err) {
      logger.warn('启动探活失败（不影响启动）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const registry = createDefaultSkillRegistry();
  const stats = registry.stats();
  logger.info('技能注册表已装载', {
    total: stats.total,
    implemented: stats.implemented,
    pending: stats.pending.length,
  });

  const deps = buildSkillDeps({ router: modelRuntime.router, models: modelRuntime.models });

  // ③ 事件总线
  // 进程内复用一条 Redis 连接：任务状态、进度与资产变更经此推送给 SSE 端点。
  // 发布是「发射后不管」的（见 events.ts），Redis 抖动不会拖慢或中断任务执行。
  const eventPublisher = createEventPublisher({
    connection: parseRedisConnection(env.REDIS_URL),
    logger: {
      // 发布器的 debug/info 对排障没有增量价值，避免刷日志；异常走 warn/error
      debug: () => undefined,
      info: () => undefined,
      warn: (msg, meta) => logger.warn(msg, meta),
      error: (msg, meta) => logger.error(msg, meta),
    },
  });
  const events = createEventSink(eventPublisher);

  // ④ 队列与运行器
  // 运行器在每次作业开始时自行构造执行器（见 runner.ts 的说明），
  // 因此这里只需把注册表、依赖与队列交给它。
  const queues: TaskQueuePool = createTaskQueuePool(env.REDIS_URL, env.QUEUE_PREFIX);
  const runner = new TaskRunner({
    registry,
    deps,
    queues,
    workerId,
    logger,
    events,
    // 全局默认：遇到高成本技能时置为 waiting_user，等待用户确认。
    // 用户确认后任务会带上 `confirmedAt`，运行器据此**仅对那一次执行**放行
    // （见 runner.ts 的 buildExecutor）；这里的默认值始终是 reject。
    confirmationPolicy: 'reject',
  });

  // ⑤ 启动各资源池 Worker
  const workers = TASK_QUEUES.map((queueName: TaskQueueName) =>
    createTaskWorker({
      redisUrl: env.REDIS_URL,
      prefix: env.QUEUE_PREFIX,
      queueName,
      workerId,
      handler: async (job): Promise<TaskJobResult> => runner.handleJob(job.data),
    }),
  );

  logger.info(`已启动 ${workers.length} 个资源池消费者`, {
    queues: TASK_QUEUES.join(', '),
  });

  // ⑥ 配置变更刷新
  // 用户在设置里改完 Provider 配置后，正在运行的 Worker 应当自动生效，
  // 而不是必须重启进程。这里用「配置版本号」做轻量检测：
  // 版本变了才重建 Model Router，避免无谓的重复查询与构造。
  let runtimeVersion = await computeProviderConfigVersion();

  const refreshTimer = setInterval(() => {
    void (async () => {
      if (!(await needsRuntimeRefresh(runtimeVersion))) return;

      logger.info('检测到模型服务配置变更，正在重建 Model Router');
      try {
        const rebuilt = await refreshModelRuntime({
          encryptionKey: env.SECRET_ENCRYPTION_KEY,
          logger: {
            info: (msg, meta) => logger.info(msg, meta),
            warn: (msg, meta) => logger.warn(msg, meta),
          },
        });

        // 就地替换运行器的依赖：新任务会用到新配置
        runner.replaceDeps(buildSkillDeps({ router: rebuilt.router, models: rebuilt.models }));

        runtimeVersion = await computeProviderConfigVersion();
        logger.info('模型服务已刷新', {
          providers: rebuilt.providers.length,
          models: rebuilt.models.length,
          usingMock: rebuilt.usingMock,
        });
      } catch (err) {
        logger.error('模型服务刷新失败，继续沿用旧配置', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })().catch((err: unknown) => {
      logger.error('配置刷新检测异常', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, CONFIG_REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  // ⑦ 对账循环
  const reconcileTimer = setInterval(() => {
    void (async () => {
      const reclaimed = await reclaimExpiredTasks();
      if (reclaimed.length === 0) return;

      logger.warn(`对账：回收 ${reclaimed.length} 个租约过期的任务`);

      // 回收后重新入队，让任务能被再次抢占
      for (const taskId of reclaimed) {
        const task = await prisma.agentTask.findUnique({
          where: { id: taskId },
          // sessionId 是广播的必需字段：下面两条路径都要发事件
          select: {
            attempts: true,
            maxAttempts: true,
            queueName: true,
            status: true,
            sessionId: true,
          },
        });
        if (!task || task.status !== 'pending') continue;

        if (task.attempts >= task.maxAttempts) {
          logger.warn(`任务 ${taskId} 已耗尽尝试次数，标记为失败`);
          const written = await prisma.agentTask.updateMany({
            where: { id: taskId, status: 'pending' },
            data: {
              status: 'failed',
              error: '租约多次过期，已放弃',
              errorMessage: RECONCILE_GIVE_UP_MESSAGE,
              finishedAt: new Date(),
            },
          });
          /*
           * `failed` 是**终态**：写进去之后不会再有执行去纠正它。
           * 不广播的话，前端会永久停在 `running`（或上一次的状态），
           * 直到用户手动刷新页面 —— 而任务其实早已被判失败。
           *
           * 判据与写库同源：只有这次 CAS 真的命中（说明状态确实由对账改写）
           * 才广播，避免播出一个数据库里并不存在的状态。
           */
          if (written.count > 0) {
            events.emit({
              sessionId: task.sessionId,
              type: 'task.status',
              data: { taskId, status: 'failed', message: RECONCILE_GIVE_UP_MESSAGE },
            });
          }
          continue;
        }

        if (task.queueName === null) continue;
        await queues.enqueue({
          taskId,
          queueName: task.queueName,
          attempt: task.attempts + 1,
        });

        /*
         * 重入队后状态已经回到 `pending`（由 reclaimExpiredTasks 的 CAS 写入），
         * 这里补一条广播：否则队列里明明躺着这条任务，前端却一直显示上一次的
         * `running` / 失败态，看起来像卡死了。sessionId 为空时 emit 内部自动跳过。
         */
        events.emit({
          sessionId: task.sessionId,
          type: 'task.status',
          data: { taskId, status: 'pending' },
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

  // ⑧ 优雅关闭
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
    clearInterval(refreshTimer);

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

    // 3) 关闭队列连接、事件连接与数据库
    // 事件连接必须显式释放：它是一条长连接，留着会让进程无法自然退出
    await queues.close();
    await eventPublisher.close();
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
