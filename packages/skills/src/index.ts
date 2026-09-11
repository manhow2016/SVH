/**
 * @svh/skills —— Skill 目录
 *
 * Phase 1 交付范围：**只交付能力的声明式元数据，不含执行实现**。
 * 执行链路（Skill Registry → Worker → Model Router）属于 Phase 2 / Phase 3。
 *
 * 本包存在的直接理由：Workflow 节点通过 `skill` 字段引用技能 id，
 * 若没有这份目录，四套内置工作流引用的就是悬空字符串，无法校验。
 */
export {
  SKILL_CATALOG,
  findSkillByAlias,
  findSkillsByCapability,
  getSkill,
  listSkillIds,
  listSkills,
} from './catalog.js';
export type { SkillCatalogEntry } from './catalog.js';
