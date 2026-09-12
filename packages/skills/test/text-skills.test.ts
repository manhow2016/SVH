/**
 * 文本类技能的纯函数测试
 *
 * 覆盖两个关键点：
 * 1. `validateRequirement` 在模型给出非法枚举值时的回退行为
 * 2. `applyContentTypeConstraints` 按内容类型剔除不适用字段
 *    （防止「短视频被填上 66 集」这类不自洽数据流入下游）
 */
import { describe, expect, it } from 'vitest';

import {
  applyContentTypeConstraints,
  validateRequirement,
  type RequirementAnalysis,
} from '../src/implementations/text-skills.js';

describe('validateRequirement', () => {
  it('合法的 content_type 被采用', () => {
    const result = validateRequirement(
      { content_type: 'short_drama', goal: '做三集古装复仇短剧' },
      {},
    );
    expect(result.content_type).toBe('short_drama');
    expect(result.goal).toBe('做三集古装复仇短剧');
  });

  it('非法的 content_type 回退为 advertisement 而不是抛错', () => {
    const result = validateRequirement({ content_type: 'not_a_type', goal: 'x' }, {});
    expect(result.content_type).toBe('advertisement');
  });

  it('用户显式提供的参数优先于模型推断', () => {
    const result = validateRequirement(
      { content_type: 'advertisement', goal: 'x', duration: 60, audience: '模型猜的' },
      { duration: 30, audience: '年轻女性' },
    );
    expect(result.duration).toBe(30);
    expect(result.audience).toBe('年轻女性');
  });

  it('缺少 goal 时给出兜底值而不是空字符串', () => {
    const result = validateRequirement({ content_type: 'advertisement' }, {});
    expect(result.goal).toBe('创作内容');
  });

  it('非对象输入抛出可识别的错误', () => {
    expect(() => validateRequirement('不是对象', {})).toThrow(/不是对象/);
  });
});

describe('applyContentTypeConstraints —— 按类型剔除不适用字段', () => {
  const base: RequirementAnalysis = {
    content_type: 'short_video',
    goal: '做一条短视频',
    duration: 30,
    episodes: 66,
    genre: '古装',
    sellingPoints: ['卖点A'],
  };

  it('短视频不应保留「集数」与「题材」', () => {
    const analysis: RequirementAnalysis = { ...base };
    applyContentTypeConstraints(analysis);
    expect(analysis.episodes).toBeUndefined();
    expect(analysis.genre).toBeUndefined();
    // 短视频可以带产品卖点（带货场景）
    expect(analysis.sellingPoints).toEqual(['卖点A']);
  });

  it('广告保留卖点，但不应有「集数」', () => {
    const analysis: RequirementAnalysis = { ...base, content_type: 'advertisement' };
    applyContentTypeConstraints(analysis);
    expect(analysis.episodes).toBeUndefined();
    expect(analysis.genre).toBeUndefined();
    expect(analysis.sellingPoints).toEqual(['卖点A']);
  });

  it('短剧保留集数与题材，但不应有产品卖点', () => {
    const analysis: RequirementAnalysis = { ...base, content_type: 'short_drama' };
    applyContentTypeConstraints(analysis);
    expect(analysis.episodes).toBe(66);
    expect(analysis.genre).toBe('古装');
    expect(analysis.sellingPoints).toBeUndefined();
  });

  it('宣传片剔除卖点与题材，保留集数以外的字段', () => {
    const analysis: RequirementAnalysis = { ...base, content_type: 'promo' };
    applyContentTypeConstraints(analysis);
    expect(analysis.sellingPoints).toBeUndefined();
    // 宣传片不保留题材（genre 只在短剧语境有意义）
    expect(analysis.genre).toBeUndefined();
    expect(analysis.episodes).toBeUndefined();
  });

  it('视觉内容剔除卖点', () => {
    const analysis: RequirementAnalysis = { ...base, content_type: 'visual_content' };
    applyContentTypeConstraints(analysis);
    expect(analysis.sellingPoints).toBeUndefined();
  });
});
