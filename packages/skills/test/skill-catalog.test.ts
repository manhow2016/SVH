/**
 * Skill 目录自身合法性测试
 *
 * 验证技术文档第 20 / 21 条要求的基础技能与专业技能都已登记，
 * 且风险等级、别名等元数据自洽。
 *
 * 说明：Workflow 节点 ↔ Skill 的**交叉一致性**测试放在
 * `@svh/workflow` 包中（见 packages/workflow/test/skill-references.test.ts），
 * 因为依赖方向是 workflow → skills，反过来会造成循环依赖。
 */
import { describe, expect, it } from 'vitest';

import { skillDefinitionSchema } from '@svh/domain';

import { getSkill, listSkillIds, listSkills, SKILL_CATALOG } from '../src/index.js';

describe('Skill 目录自身合法性', () => {
  it('所有技能定义通过 Schema 校验', () => {
    for (const entry of SKILL_CATALOG) {
      expect(() => skillDefinitionSchema.parse(entry.definition)).not.toThrow();
    }
  });

  it('技能 id 唯一', () => {
    const ids = listSkillIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个技能都绑定了一个资源池队列', () => {
    for (const entry of SKILL_CATALOG) {
      expect(entry.queue, `${entry.definition.id} 未指定队列`).toBeTruthy();
    }
  });

  it('技术文档第 20 条要求的基础 Skill 全部存在', () => {
    const required = [
      'text.generate',
      'script.generate',
      'image.generate',
      'image.edit',
      'video.generate',
      'video.extend',
      'audio.generate',
      'voice.generate',
      'digital_human.generate',
      'subtitle.generate',
      'edit.video',
      'asset.create',
      'asset.update',
    ];
    const ids = new Set(listSkillIds());
    for (const id of required) {
      expect(ids.has(id), `缺少基础技能 ${id}`).toBe(true);
    }
  });

  it('技术文档第 21 条要求的专业 Skill 全部存在', () => {
    const required = [
      'advertisement.idea',
      'advertisement.script',
      'advertisement.storyboard',
      'advertisement.generate',
      'short_video.topic',
      'short_video.script',
      'short_video.storyboard',
      'short_video.generate',
      'drama.script',
      'drama.character',
      'drama.scene',
      'drama.episode',
      'drama.storyboard',
      'digital_human.script',
      'digital_human.voice',
      'digital_human.video',
    ];
    const ids = new Set(listSkillIds());
    for (const id of required) {
      expect(ids.has(id), `缺少专业技能 ${id}`).toBe(true);
    }
  });

  it('高成本技能必须标记为需要用户确认（技术文档第 47 条）', () => {
    const highRiskSkills = listSkills().filter((s) => s.risk === 'high');
    expect(highRiskSkills.length).toBeGreaterThan(0);

    for (const skill of highRiskSkills) {
      expect(
        skill.requiresConfirmation,
        `高风险技能 ${skill.id} 必须 requiresConfirmation=true，否则会在用户未确认时消耗大量额度`,
      ).toBe(true);
    }
  });

  it('不声明模型能力的技能只能是本地执行类（剪辑 / 资产）', () => {
    const localOnlyCategories = new Set(['edit', 'asset']);
    for (const skill of listSkills()) {
      if (skill.capabilities.length === 0) {
        expect(
          localOnlyCategories.has(skill.category),
          `${skill.id} 未声明模型能力，但类别为 ${skill.category}，请补全 capabilities`,
        ).toBe(true);
      }
    }
  });

  it('技能 id 命名符合 <域>.<动作> 规范', () => {
    for (const id of listSkillIds()) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Skill 别名（用于 /技能 指令，技术文档第 59 条）', () => {
  it('/技能 菜单需要的能力都配置了中文别名', () => {
    const expected = [
      'advertisement.generate',
      'script.generate',
      'image.generate',
      'video.generate',
      'digital_human.generate',
      'voice.generate',
      'edit.video',
    ];
    for (const id of expected) {
      const skill = getSkill(id);
      expect(skill, `缺少技能 ${id}`).toBeDefined();
      expect(
        skill?.definition.aliases.length,
        `${id} 没有中文别名，用户无法通过 / 菜单触达`,
      ).toBeGreaterThan(0);
    }
  });

  it('别名不重复（否则 /写脚本 会产生歧义）', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const skill of listSkills()) {
      for (const alias of skill.aliases) {
        const existing = seen.get(alias);
        if (existing !== undefined) {
          duplicates.push(`别名「${alias}」同时属于 ${existing} 与 ${skill.id}`);
        }
        seen.set(alias, skill.id);
      }
    }

    expect(duplicates).toEqual([]);
  });
});
