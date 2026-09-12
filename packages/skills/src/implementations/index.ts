/**
 * 已实现的 Skill 清单
 *
 * 技术文档第 81 条要求 Phase 2 先实现 text.generate / image.generate /
 * video.generate / asset.create / asset.update。本文件在此基础上补齐了
 * 同链路的其它技能，使「脚本 → 画面 → 视频 → 配音 → 字幕 → 剪辑 → 输出」
 * 可以端到端跑通（这是验证任务链路是否真正可用的必要条件）。
 *
 * 尚未实现的技能（目录中已声明、执行时给出明确提示）：
 *   - 广告 / 短视频 / 短剧 / 数字人 的**业务编排类**技能
 *     （advertisement.* / short_video.* / drama.* / digital_human.*）
 *   - product.visual / asset.prepare / drama.character_visual 等
 *     这些需要「一稿多图 + 依赖角色一致性」的更复杂编排，属于 Phase 8。
 */
import type { SkillImplementation } from '../runtime/registry.js';

import { assetCreateSkill, assetUpdateSkill } from './asset-skills.js';
import {
  audioGenerateSkill,
  imageEditSkill,
  imageGenerateSkill,
  subtitleGenerateSkill,
  videoExtendSkill,
  videoGenerateSkill,
  voiceGenerateSkill,
} from './generation-skills.js';
import { brandOverlaySkill, editVideoSkill, outputPublishSkill } from './media-skills.js';
import { requirementAnalyzeSkill, scriptGenerateSkill, textGenerateSkill } from './text-skills.js';

/** 全部已实现的技能 */
export const SKILL_IMPLEMENTATIONS: SkillImplementation<never>[] = [
  // 基础技能（技术文档第 20 条）
  textGenerateSkill,
  scriptGenerateSkill,
  imageGenerateSkill,
  imageEditSkill,
  videoGenerateSkill,
  videoExtendSkill,
  audioGenerateSkill,
  voiceGenerateSkill,
  subtitleGenerateSkill,
  editVideoSkill,
  assetCreateSkill,
  assetUpdateSkill,

  // 流程通用技能（被四套内置 Workflow 引用）
  requirementAnalyzeSkill,
  brandOverlaySkill,
  outputPublishSkill,
] as unknown as SkillImplementation<never>[];

export {
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
};
