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

// 任务运行时仓储：把 @svh/domain 的幂等 / CAS / Fencing 契约接进执行路径
export {
  appendTaskStep,
  cancelTask,
  claimTask,
  completeTask,
  computeRetryDelay,
  createTask,
  failTask,
  parkTaskForConfirmation,
  reclaimExpiredTasks,
  recordModelTask,
  renewLease,
  updateTaskProgress,
} from './tasks.js';
export type { ClaimResult, CreateTaskResult, FailResult, FencingContext } from './tasks.js';

// 密钥加解密（模型 API Key 落库前加密）
export { decryptSecret, encryptSecret, maskSecret, safeEqual } from './crypto.js';

// 会话消息的唯一写入入口（API 与 Worker 共用）
export { appendSessionMessage } from './sessions.js';
export type { AppendSessionMessageResult } from './sessions.js';

// 模型运行时装配：把数据库中的 Provider / Model 翻译为 Model Router 的输入
export { buildModelRuntime, MOCK_PROVIDER_ID } from './model-runtime.js';
export type { BuildModelRuntimeOptions, ModelRuntime } from './model-runtime.js';

// 资产写入的唯一入口（API 与 Skill 共用同一套校验）
export {
  buildAssetData,
  ensureUniqueSlug,
  linkAssetReference,
  persistAsset,
  persistAssetPatch,
  resolveAssetsBySlug,
  slugifyAssetName,
} from './asset-service.js';
export type { NormalizedAssetData } from './asset-service.js';

// 分镜仓储：镜头 CRUD、顺序重排与资产引用同步（API 与 Worker 共用同一套顺序规则）
export {
  createShot,
  deleteShot,
  listShots,
  listShotsReferencingAsset,
  reorderShots,
  syncShotAssetRefs,
  updateShot,
} from './storyboard.js';
export type { StoryboardShotRow } from './storyboard.js';

// 时间线仓储：默认轨幂等创建、片段 CRUD 与同轨不重叠守卫（API 与 Worker 共用）
export {
  createClip,
  deleteClip,
  ensureDefaultTracks,
  getTimeline,
  moveClip,
  updateClip,
} from './timeline.js';
export type { TimelineClipRow, TimelineTrackRow } from './timeline.js';

// 导演动作仓储：提案校验、确认推导与 CAS 状态转移（API 与 Worker 共用同一套状态机）
export {
  cancelAction,
  confirmAction,
  createAction,
  DIRECTOR_ACTION_OPERATIONS,
  getAction,
  listActions,
  markExecuted,
  markExecuting,
  markFailed,
  rejectAction,
} from './director-actions.js';
export type {
  CreateActionInput,
  DirectorActionOperation,
  DirectorActionRow,
} from './director-actions.js';

// Provider 健康检查与运行时刷新（Phase 3）
export {
  computeProviderConfigVersion,
  DEGRADED_AFTER_FAILURES,
  DOWN_AFTER_FAILURES,
  deriveHealth,
  needsRuntimeRefresh,
  probeAllProviders,
  probeProvider,
  recordProviderFailure,
  recordProviderSuccess,
  refreshModelRuntime,
  updateProviderHealth,
} from './provider-health.js';
export type { HealthProbeResult } from './provider-health.js';
