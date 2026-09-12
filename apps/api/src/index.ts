/**
 * API 服务入口
 *
 * ── 审计结论 ⑬：进程优雅关闭是必须的，不是可选项 ──
 * 参考项目 API 侧**完全没有 shutdown hooks**，容器停止时会直接掐断在途请求，
 * 用户看到的是连接重置而非一个正常的错误响应。
 *
 * 本文件的关闭顺序（顺序本身很重要）：
 *   1. 停止接受新连接（server.close）
 *   2. 等待在途请求完成，超时则强制关闭
 *   3. 关闭数据库连接池
 *   4. 退出
 *
 * ── 审计结论 ⑪：配置在任何模块被 import 之前校验 ──
 * `bootstrapConfig()` 是第一步，配置不合法立即退出，绝不带病启动。
 */
import { bootstrapConfig, EnvValidationError } from '@svh/config';
import { disconnectPrisma, registerPrismaShutdown } from '@svh/database';

import { buildApp } from './core/app.js';
import { closeEventPublisher } from './core/events.js';
import { closeQueuePool } from './core/tasks.js';

/** 优雅关闭的等待上限：超过则强制退出，避免容器卡在 stopping 状态 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  // ① 加载 .env 并校验环境变量（fail-fast）
  let env;
  let envFile;
  try {
    const boot = bootstrapConfig();
    env = boot.env;
    envFile = boot.envFile;
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // 配置问题必须在启动阶段暴露，且给出可操作的修复指引
      console.error('\n[SVH] 启动失败：环境变量配置不正确\n');
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // ② 装配应用
  const app = await buildApp();

  app.log.info(
    {
      envFile: envFile.path ?? '(未找到 .env，使用进程环境变量)',
      nodeEnv: env.NODE_ENV,
      storageDriver: env.STORAGE_DRIVER,
    },
    '环境配置已加载',
  );

  // ③ 监听端口
  await app.listen({ host: env.API_HOST, port: env.API_PORT });

  app.log.info(
    { url: `http://${env.API_HOST}:${env.API_PORT}` },
    'SVH API 已启动（健康检查：/healthz 存活探针，/readyz 就绪探针）',
  );

  // ④ 注册优雅关闭
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      app.log.warn({ signal }, '已在关闭流程中，忽略重复信号');
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, '收到退出信号，开始优雅关闭');

    // 兜底：若清理逻辑卡住，超时后强制退出，避免容器无法停止
    const forceExit = setTimeout(() => {
      app.log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, '优雅关闭超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // 1) 停止接受新连接，并等待在途请求结束
      await app.close();
      app.log.info('HTTP 服务已关闭，在途请求已处理完毕');

      // 2) 释放 Redis 连接（队列池 + 事件总线），避免连接泄漏
      await closeQueuePool();
      await closeEventPublisher();
      app.log.info('Redis 连接已释放（队列池、事件总线）');

      // 3) 释放数据库连接池
      await disconnectPrisma();
      app.log.info('数据库连接已释放');

      clearTimeout(forceExit);
      app.log.info('优雅关闭完成');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '优雅关闭过程中出错');
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal).catch((err: unknown) => {
      app.log.error({ err }, '关闭流程未预期失败');
      process.exit(1);
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // 未捕获异常：记录后按正常流程退出，避免进程处于未定义状态
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, '未捕获异常，进程即将退出');
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, '未处理的 Promise 拒绝，进程即将退出');
    shutdown('unhandledRejection').catch(() => process.exit(1));
  });

  // 数据库层面的退出钩子（与上面的 app 关闭互补，确保连接一定被释放）
  registerPrismaShutdown();
}

main().catch((err: unknown) => {
  console.error('[SVH] 启动过程中发生未预期错误：', err);
  process.exit(1);
});
