/**
 * 健康检查路由
 *
 * 区分两个语义不同的端点，这是容器编排（K8s / Docker healthcheck）的正确用法：
 * - `/healthz`（liveness）：进程是否活着。**不检查依赖**，否则数据库抖动
 *   会导致容器被反复重启，把小故障放大成大故障。
 * - `/readyz`（readiness）：是否可对外提供服务。检查数据库与队列，
 *   未就绪时返回 503，编排系统会把流量摘掉但不重启进程。
 */
import type { FastifyInstance } from 'fastify';

import { checkDatabaseHealth } from '@svh/database';
import { getEnv } from '@svh/config';

import { checkQueueHealth } from '../core/queue-health.js';

/** 依赖检查结果 */
interface DependencyStatus {
  ok: boolean;
  latencyMs: number;
  /** 面向运维的简短说明；不返回给终端用户 */
  error?: string;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * liveness：只证明进程能响应 HTTP。
   */
  app.get('/healthz', async () => {
    const env = getEnv();
    return {
      status: 'ok',
      service: 'svh-api',
      version: '0.1.0',
      env: env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * readiness：检查数据库与队列。
   * 任一依赖不可用即返回 503，并给出可操作的排查建议。
   */
  app.get('/readyz', async (_request, reply) => {
    const [database, queue] = await Promise.all([
      checkDatabaseHealth(),
      checkQueueHealth(getEnv().REDIS_URL),
    ]);

    const dependencies: Record<string, DependencyStatus> = {
      database: {
        ok: database.ok,
        latencyMs: database.latencyMs,
        ...(database.error !== undefined ? { error: database.error } : {}),
      },
      queue: {
        ok: queue.ok,
        latencyMs: queue.latencyMs,
        ...(queue.error !== undefined ? { error: queue.error } : {}),
      },
    };

    const ready = database.ok && queue.ok;

    // 未就绪时给出排查方向，而不是只回一个 503
    const suggestions: string[] = [];
    if (!database.ok) {
      suggestions.push('检查 PostgreSQL 是否运行，以及 DATABASE_URL 是否正确');
    }
    if (!queue.ok) {
      suggestions.push('检查 Redis 是否运行，以及 REDIS_URL 是否正确');
    }

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      dependencies,
      ...(ready ? {} : { suggestions }),
      timestamp: new Date().toISOString(),
    });
  });
}
