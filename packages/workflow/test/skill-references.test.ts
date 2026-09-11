/**
 * Workflow 节点 ↔ Skill 目录 交叉一致性测试
 *
 * 四套内置工作流的每个节点都通过 `skill` 字段引用技能 id。
 * 如果引用了不存在的技能，流程要到运行到该节点时才会暴露 —— 太晚了。
 * 本测试把它变成**提交即可发现**的问题。
 *
 * 该测试放在 `@svh/workflow` 而非 `@svh/skills`，是为了保持依赖方向单向：
 * workflow → skills。反过来会造成包循环依赖。
 */
import { describe, expect, it } from 'vitest';

import { getSkill } from '@svh/skills';

import {
  advertisementWorkflow,
  digitalHumanWorkflow,
  listBuiltinWorkflows,
  shortDramaWorkflow,
  shortVideoWorkflow,
} from '../src/index.js';

describe('Workflow 节点引用的技能全部存在', () => {
  it('每个流程节点的 skill 都能在目录中找到', () => {
    const missing: string[] = [];

    for (const wf of listBuiltinWorkflows()) {
      for (const node of wf.nodes) {
        if (node.skill === undefined) continue;
        if (getSkill(node.skill) === undefined) {
          missing.push(`${wf.type} → ${node.key} 引用了不存在的技能 ${node.skill}`);
        }
      }
    }

    expect(missing, `以下节点引用了未注册的技能：\n${missing.join('\n')}`).toEqual([]);
  });

  it.each([
    ['广告', advertisementWorkflow],
    ['短视频', shortVideoWorkflow],
    ['短剧', shortDramaWorkflow],
    ['数字人', digitalHumanWorkflow],
  ])('%s 流程至少引用 8 个技能（证明流程不是空壳）', (_name, wf) => {
    const skillNodes = wf.nodes.filter((n) => n.skill !== undefined);
    expect(skillNodes.length).toBeGreaterThanOrEqual(8);
  });

  it('标记为高成本的节点，其技能必须被标记为高风险（会触发用户确认）', () => {
    // 语义约定：节点上的 `highCost: true` 严格等价于「执行到这里会向用户
    // 请求确认」。因此它引用的技能必须声明 risk=high。
    // 若某天需要「按数量确认」（例如生成 1 张图不确认、生成 20 张要确认），
    // 应把该判断放进 Skill 实现内部，而不是靠节点上的静态标记。
    const offenders: string[] = [];
    for (const wf of listBuiltinWorkflows()) {
      for (const node of wf.nodes) {
        if (!node.highCost || node.skill === undefined) continue;
        const entry = getSkill(node.skill);
        if (!entry) continue;
        if (entry.definition.risk !== 'high') {
          offenders.push(
            `${wf.type} → ${node.key} 标记为 highCost，但技能 ${node.skill} 的风险等级是 ${entry.definition.risk}`,
          );
        }
      }
    }
    expect(offenders, `高成本节点与技能风险等级不一致：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('视频与数字人合成节点必须标记为高成本（技术文档第 47 条）', () => {
    for (const wf of listBuiltinWorkflows()) {
      const videoNodes = wf.nodes.filter(
        (n) => n.skill === 'video.generate' || n.skill === 'digital_human.generate',
      );
      expect(videoNodes.length, `${wf.type} 没有视频类节点`).toBeGreaterThan(0);
      for (const node of videoNodes) {
        expect(node.highCost, `${wf.type} → ${node.key} 应当标记为 highCost`).toBe(true);
      }
    }
  });
});
