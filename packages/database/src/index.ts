/**
 * @svh/database —— SVH 数据层
 *
 * 对外暴露：
 * - `prisma`：全局 Prisma Client 单例
 * - 生成的模型类型与枚举（供仓储层使用）
 *
 * 注意：业务代码应通过仓储 / 领域服务访问数据库，
 * 不要在各处直接拼装 Prisma 查询，避免数据访问逻辑分散。
 */

export * from './generated/prisma/client.js';
export { prisma, createPrismaClient, checkDatabaseHealth, disconnectPrisma, registerPrismaShutdown } from './client.js';
export type { PrismaLogLevel } from './client.js';

// 仓储辅助：把跨路由复用的数据访问逻辑收敛在这里，
// 避免同一段查询在多个路由里各写一遍。
export {
  createAssetVersion,
  listAssetVersions,
  getAssetVersion,
  restoreAssetVersion,
  findAssetReferences,
  countAssetReferences,
  toSnapshot,
} from './assets.js';
export type { VersionContext } from './assets.js';
