/**
 * Fastify 应用装配
 *
 * 设计约定（审计结论 ⑮）：**入口只做装配，一个域一个插件文件**。
 * 参考项目把两个 app 的入口写成 370~1451 行的巨型 main，
 * 且有 4 个域把 Module 定义塞在 controller 文件里 —— SVH 必须避免。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

import { getEnv } from '@svh/config';

import { buildLoggerOptions } from './logger.js';
import { registerErrorHandler } from './error-handler.js';
import { healthRoutes } from '../routes/health.js';
import { projectRoutes } from '../routes/projects.js';
import { contentRoutes } from '../routes/contents.js';
import { assetRoutes } from '../routes/assets.js';
import { skillRoutes } from '../routes/skills.js';
import { workflowRoutes } from '../routes/workflows.js';
import { taskRoutes } from '../routes/tasks.js';
import { providerRoutes } from '../routes/providers.js';
import { agentRoutes } from '../routes/agent.js';
import { eventRoutes, registerSseShutdown } from '../routes/events.js';

export interface BuildAppOptions {
  /** 覆盖日志级别（测试环境用 silent） */
  logLevel?: string;
}

/**
 * 构建 Fastify 实例。
 *
 * 与 `startServer` 分离，使测试可以直接 `app.inject()` 而不监听端口。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();
  const isProduction = env.NODE_ENV === 'production';

  const app = Fastify({
    logger:
      options.logLevel === 'silent'
        ? false
        : { ...buildLoggerOptions(env.LOG_LEVEL, isProduction), ...(options.logLevel ? { level: options.logLevel } : {}) },
    // 生成的请求 id 会回传给客户端（错误响应里的 requestId），便于对日志
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
    // 素材生成结果的请求体可能较大（分镜数据）
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  // ── 横切关注点 ──────────────────────────────────────────────
  registerErrorHandler(app);

  await app.register(cors, {
    origin: isProduction ? [env.API_PUBLIC_URL] : true,
    credentials: true,
  });

  // ── 每请求的起始日志（含耗时统计） ──────────────────────────
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      '请求完成',
    );
  });

  // ── 路由插件：一域一文件 ────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(contentRoutes, { prefix: '/api/contents' });
  await app.register(assetRoutes, { prefix: '/api/assets' });
  await app.register(skillRoutes, { prefix: '/api/skills' });
  await app.register(workflowRoutes, { prefix: '/api/workflows' });
  await app.register(taskRoutes, { prefix: '/api/tasks' });
  await app.register(providerRoutes, { prefix: '/api/models/providers' });
  await app.register(agentRoutes, { prefix: '/api/agent' });
  // SSE 与普通 JSON 路由的响应处理差异很大，单独成文件、与 agentRoutes 并列
  await app.register(eventRoutes, { prefix: '/api/agent' });

  /*
   * SSE 的关闭钩子必须**尽早**注册，不能放进 eventRoutes 插件体。
   *
   * 关闭活跃 SSE 连接依赖 `preClose` 钩子先于 fastify 内部的 `server.close()`
   * 执行；而内部 onClose 钩子是在 `preReady` 阶段压入 avvio 关闭队列的。
   * 在插件体里注册虽然也能赶上 `preReady` 之前，但把这条关键时序散落在路由文件
   * 深处会让它很容易被后来者挪动或删掉 —— 放在装配层一眼可见：**没有这次注册，
   * 带活连接的进程关闭就必然走「优雅关闭超时 + exit 1」**。详见 registerSseShutdown。
   */
  registerSseShutdown(app);

  return app;
}
