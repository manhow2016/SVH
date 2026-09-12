/**
 * Skill Registry —— 技能注册表
 *
 * 技术文档第 19、81 条：
 * ```
 * Creative Agent → Skill Registry → Skill → Model Router → Provider → Model
 * ```
 *
 * 职责：
 * 1. **注册**：把 Skill 实现与它的声明式定义绑定
 * 2. **发现**：按 id / 能力 / 类别查找（供 Agent 的 Skill Selection 使用）
 * 3. **权限检查**：执行前校验会员等级（技术文档第 68 条）
 *
 * 关键约束：注册时必须校验「实现声明的 id」与「目录中的定义」一致，
 * 且**每个目录条目都必须有实现**（或显式标记为未实现）。
 * Phase 1 只交付了目录，若不强制绑定，就会出现
 * 「Agent 能选到技能但执行时报 not found」的空洞。
 */
import {
  SkillNotFoundError,
  TierRequiredError,
  type ModelCapability,
  type SkillAccessTier,
  type SkillDefinition,
} from '@svh/domain';

import { SKILL_CATALOG, type SkillCatalogEntry } from '../catalog.js';
import type { SkillDeps, SkillExecutionContext } from './ports.js';

/** Skill 执行产出 */
export interface SkillExecutionOutput {
  output: Record<string, unknown>;
  /** 执行过程中产出的资产 id 列表 */
  assetIds?: string[];
  /** 面向用户的完成说明（用于生成结果卡片文案） */
  summary?: string;
  /** 结构化结果卡片数据（供 Agent UI 渲染，技术文档第 12 条） */
  card?: Record<string, unknown>;
}

/**
 * Skill 实现接口。
 *
 * `TInput` 由实现自行收窄；注册表只保证它与目录声明的 inputSchema 语义一致
 * （Schema 是给 LLM 与前端看的，TypeScript 类型是给实现看的）。
 */
export interface SkillImplementation<TInput = Record<string, unknown>> {
  /** 必须与目录中的 id 完全一致 */
  readonly id: string;
  /** 入参归一化：把上游传进来的自由 JSON 收敛为强类型输入，非法时抛 ValidationError */
  normalizeInput?(input: Record<string, unknown>): TInput;
  /**
   * 动态高风险判定。
   *
   * 为什么需要它：有些技能的成本取决于**本次调用的规模**而不是技能本身。
   * 例如生成 1 张图属于常规操作，一次生成 20 张则应当先征求用户确认。
   * 静态的 `definition.requiresConfirmation` 无法表达这种差异，
   * 因此把判断放进技能实现——它才看得到归一化后的具体入参。
   *
   * 返回 `true` 时执行器会要求确认（除非策略为 allow）。
   * @param input 已归一化的输入
   */
  isHighRisk?(input: TInput): boolean;
  execute(input: TInput, ctx: SkillExecutionContext): Promise<SkillExecutionOutput>;
}

/** 注册项 */
export interface RegisteredSkill {
  entry: SkillCatalogEntry;
  definition: SkillDefinition;
  implementation: SkillImplementation<never> | null;
  /** 是否已实现（未实现时执行会抛出明确的错误，而不是静默失败） */
  implemented: boolean;
}

/** 权限检查上下文 */
export interface AccessContext {
  /** 用户当前会员等级；未提供表示「不做限制」（如内部任务） */
  tier?: SkillAccessTier | undefined;
}

/** 会员等级的可比顺序 */
const TIER_RANK: Record<SkillAccessTier, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();

  constructor(options: { allowUnimplemented?: boolean } = {}) {
    // 默认允许「已声明未实现」——Phase 2 有大量技能属于后续阶段，
    // 但它们必须能被列出（`/技能` 菜单）与被权限检查。
    void (options.allowUnimplemented ?? true);
  }

  /** 注册一个 Skill 实现 */
  register(implementation: SkillImplementation<never>): void {
    const existing = this.skills.get(implementation.id);
    if (existing === undefined) {
      throw new SkillNotFoundError(
        `技能 ${implementation.id} 未在目录中声明，无法注册实现。` +
          `请先在 packages/skills/src/catalog.ts 中补充定义。`,
        { context: { skillId: implementation.id } },
      );
    }
    if (existing.implemented) {
      throw new SkillNotFoundError(`技能 ${implementation.id} 已经注册过实现，不允许重复注册`, {
        context: { skillId: implementation.id },
      });
    }
    existing.implementation = implementation;
    existing.implemented = true;
  }

  /** 从代码目录装载全部技能声明 */
  loadCatalog(entries: readonly SkillCatalogEntry[] = SKILL_CATALOG): void {
    for (const entry of entries) {
      this.skills.set(entry.definition.id, {
        entry,
        definition: entry.definition,
        implementation: null,
        implemented: false,
      });
    }
  }

  /** 取单个技能 */
  get(skillId: string): RegisteredSkill | undefined {
    return this.skills.get(skillId);
  }

  /** 取技能定义 */
  getDefinition(skillId: string): SkillDefinition | undefined {
    return this.skills.get(skillId)?.definition;
  }

  /** 列出全部技能 */
  list(): RegisteredSkill[] {
    return [...this.skills.values()];
  }

  /** 仅列出已实现的技能 */
  listImplemented(): RegisteredSkill[] {
    return this.list().filter((s) => s.implemented);
  }

  /** 按模型能力筛选（Agent 的 Skill Selection 入口） */
  findByCapability(capability: ModelCapability): RegisteredSkill[] {
    return this.list().filter((s) =>
      (s.definition.capabilities as readonly string[]).includes(capability),
    );
  }

  /** 按类别筛选 */
  findByCategory(category: string): RegisteredSkill[] {
    return this.list().filter((s) => s.definition.category === category);
  }

  /** 统计已实现 / 未实现数量，供健康检查与文档生成 */
  stats(): { total: number; implemented: number; pending: string[] } {
    const all = this.list();
    const pending = all.filter((s) => !s.implemented).map((s) => s.definition.id);
    return { total: all.length, implemented: all.length - pending.length, pending };
  }

  /**
   * 权限检查（技术文档第 68 条）。
   *
   * Agent **必须在执行 Skill 前调用它**。未提供 tier 时视为内部任务不做限制。
   */
  assertAccess(skillId: string, access: AccessContext = {}): void {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new SkillNotFoundError(`技能 ${skillId} 不存在`, { context: { skillId } });
    }
    if (access.tier === undefined) return;

    const required = skill.definition.accessTier;
    if (TIER_RANK[access.tier] < TIER_RANK[required]) {
      throw new TierRequiredError(
        `技能 ${skillId} 需要 ${required} 等级，当前为 ${access.tier}`,
        {
          context: { skillId, requiredTier: required, currentTier: access.tier },
          userMessage: `「${skill.definition.name}」需要更高的会员等级。`,
          suggestions: ['升级会员后使用', '改用基础技能'],
        },
      );
    }
  }

  /**
   * 取可执行的技能实现。
   *
   * 未实现时抛出明确的错误并说明计划阶段 —— 这比「静默返回空结果」
   * 或「500 错误」对用户与开发者都更有用。
   */
  resolve(skillId: string): {
    definition: SkillDefinition;
    implementation: SkillImplementation<never>;
  } {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new SkillNotFoundError(`技能 ${skillId} 不存在`, { context: { skillId } });
    }
    if (!skill.implemented || skill.implementation === null) {
      throw new SkillNotFoundError(
        `技能 ${skillId} 的执行实现尚未接入（当前处于 Phase 2 逐步实现中）`,
        {
          context: { skillId },
          userMessage: `「${skill.definition.name}」的执行能力正在开发中，当前版本尚未接通。`,
          suggestions: ['当前可使用资产与项目相关技能', '关注后续版本更新'],
        },
      );
    }
    return { definition: skill.definition, implementation: skill.implementation };
  }
}

/** 创建并装载默认技能注册表 */
export function createSkillRegistry(
  implementations: SkillImplementation<never>[] = [],
): SkillRegistry {
  const registry = new SkillRegistry();
  registry.loadCatalog();
  for (const impl of implementations) registry.register(impl);
  return registry;
}

/** 供 apps/worker 组装依赖时引用 */
export type { SkillDeps };
