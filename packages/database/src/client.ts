/**
 * Prisma Client 单例
 *
 * 设计要点
 * --------
 * 1. **全局单例**：开发模式下 tsx watch 会反复重载模块，若每次都新建
 *    PrismaClient 会耗尽数据库连接，因此把实例挂在 globalThis 上复用。
 * 2. **懒连接**：Prisma 首次查询时才真正建连，服务启动不会因数据库未就绪而崩溃。
 * 3. **优雅关闭**：进程退出前必须 disconnect，否则连接池会残留。
 * 4. **安全日志**：生产环境禁止打印 query 参数，避免提示词与密钥进日志。
 */
import { PrismaClient } from './generated/prisma/client.js';
// Prisma 命名空间提供 Prisma.TransactionClient 等辅助类型，供仓储层标注事务回调
import { Prisma } from './generated/prisma/client.js';

/** 允许注入的日志级别 */
export type PrismaLogLevel = 'query' | 'info' | 'warn' | 'error';

const isProduction = process.env.NODE_ENV === 'production';

/** 根据环境决定日志级别 */
function resolveLogLevels(): PrismaLogLevel[] {
  if (isProduction) return ['warn', 'error'];
  if (process.env.PRISMA_LOG_QUERY === '1') return ['query', 'info', 'warn', 'error'];
  return ['warn', 'error'];
}

/** 创建 PrismaClient 实例 */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: resolveLogLevels().map((level) => ({ emit: 'stdout', level })),
  });
}

/**
 * 全局缓存键。
 * 使用 globalThis 而非模块级变量，确保 tsx watch 热重载时复用同一实例。
 */
const globalForPrisma = globalThis as unknown as { __svhPrisma?: PrismaClient };

/** 全局共享的 Prisma Client */
export const prisma: PrismaClient = globalForPrisma.__svhPrisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.__svhPrisma = prisma;
}

/** 检查数据库连通性，供健康检查使用 */
export async function checkDatabaseHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 断开连接（进程退出前调用） */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * 注册进程退出钩子，确保连接被正确释放。
 * 只允许注册一次，重复调用无副作用。
 */
let shutdownRegistered = false;
export function registerPrismaShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const shutdown = (signal: string) => {
    void disconnectPrisma().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

export type { PrismaClient };
export { Prisma };
