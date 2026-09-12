/**
 * @svh/skills —— Skill 目录、注册表与执行引擎
 *
 * 技术文档第 19 / 20 / 21 / 22 / 81 条的落点。
 *
 * ```
 * Creative Agent → Skill Registry → Skill → Model Router → Provider → Model
 * ```
 *
 * 分层说明：
 * - `catalog.ts`      —— 声明式元数据（Phase 1 交付），唯一的技能 id 来源
 * - `runtime/ports.ts`   —— 注入给 Skill 的能力端口（数据库 / 模型 / 项目记忆）
 * - `runtime/registry.ts`—— 注册、发现、权限检查、实现绑定校验
 * - `runtime/executor.ts`—— 执行引擎：权限 → 确认闸门 → 归一化 → 执行 → 错误归一
 * - `implementations/`   —— 具体技能实现
 *
 * 本包**不 import** database / model 的运行时导出，只用 `import type`，
 * 因此可以脱离真实数据库做单测（审计结论 ②：端口/适配器隔离）。
 */
export {
  findSkillByAlias,
  findSkillsByCapability,
  getSkill,
  listSkillIds,
  listSkills,
  SKILL_CATALOG,
} from './catalog.js';
export type { SkillCatalogEntry } from './catalog.js';

export {
  createSkillRegistry,
  SkillRegistry,
} from './runtime/registry.js';
export type {
  AccessContext,
  RegisteredSkill,
  SkillExecutionOutput,
  SkillImplementation,
} from './runtime/registry.js';

export {
  isConfirmationRequired,
  isFatalError,
  isRetryableError,
  SkillExecutor,
} from './runtime/executor.js';
export type {
  ExecuteSkillFailure,
  ExecuteSkillRequest,
  ExecuteSkillResult,
  ExecuteSkillSuccess,
  SkillExecutorOptions,
} from './runtime/executor.js';

export type {
  SkillAssetPort,
  SkillContentPort,
  SkillDeps,
  SkillExecutionContext,
  SkillLogger,
  SkillModelPort,
  SkillModelRecordPort,
  SkillProjectPort,
  SkillProjectWritePort,
} from './runtime/ports.js';

export {
  SKILL_IMPLEMENTATIONS,
  assetCreateSkill,
  assetUpdateSkill,
  audioGenerateSkill,
  brandOverlaySkill,
  editVideoSkill,
  imageEditSkill,
  imageGenerateSkill,
  outputPublishSkill,
  requirementAnalyzeSkill,
  scriptGenerateSkill,
  subtitleGenerateSkill,
  textGenerateSkill,
  videoExtendSkill,
  videoGenerateSkill,
  voiceGenerateSkill,
} from './implementations/index.js';

// 便于使用方直接构造注册表（装载目录 + 注册全部实现）
import { SkillRegistry } from './runtime/registry.js';
import { SKILL_IMPLEMENTATIONS } from './implementations/index.js';

/**
 * 创建装载了全部已实现技能的生产注册表。
 *
 * 与 `createSkillRegistry()` 的区别：这里会把所有实现也注册进去，
 * 是 apps/worker 与 apps/api 应当使用的入口。
 */
export function createDefaultSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.loadCatalog();
  for (const impl of SKILL_IMPLEMENTATIONS) {
    registry.register(impl);
  }
  return registry;
}
