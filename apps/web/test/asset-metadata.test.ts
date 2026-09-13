/**
 * 字段表相关纯函数的测试。
 *
 * 组件测试（`metadata-form.test.tsx`）证明「界面上点得对」，
 * 这里证明「算得对」—— `diffMetadata` 的三条规则是本阶段最容易写错、
 * 也最难从界面上看出来的一处：写错了不会报错，只会**静默丢字段**。
 */
import { describe, expect, it } from 'vitest';

import { ASSET_TYPE_LABELS, ASSET_TYPE_OPTIONS } from '../src/features/assets/assetLabels.js';
import { parseFieldErrors } from '../src/features/assets/assetErrors.js';
import {
  METADATA_SPECS,
  diffMetadata,
  fieldPaths,
  isCreativeAssetType,
  type FieldSpec,
} from '../src/features/assets/metadata/specs.js';
import { ASSET_TYPES } from '../src/lib/api-types.js';

const SPECS: readonly FieldSpec[] = [
  { kind: 'text', key: 'hair', label: '发型' },
  { kind: 'number', key: 'heightCm', label: '身高' },
  { kind: 'tags', key: 'accessories', label: '配饰' },
  { kind: 'group', key: 'appearance', label: '外观', fields: [{ kind: 'text', key: 'hair', label: '发型' }] },
];

describe('diffMetadata：只提交改动过的字段', () => {
  it('没有任何改动时返回空对象（表单没碰过的字段一个都不发）', () => {
    const initial = { hair: '黑色长直发', appearance: { hair: '黑色长直发' } };
    expect(diffMetadata(SPECS, initial, { ...initial })).toEqual({});
  });

  it('改了哪个字段就只发哪个字段，且发的是完整数组', () => {
    const initial = { hair: '黑色长直发', accessories: ['玉佩'] };
    const patch = diffMetadata(SPECS, initial, {
      hair: '红色短发',
      accessories: ['玉佩', '团扇'],
    });
    expect(patch).toEqual({ hair: '红色短发', accessories: ['玉佩', '团扇'] });
  });

  it('清空一个原本有值的字段发 null（服务端 deepMerge 的显式清除语义）', () => {
    expect(diffMetadata(SPECS, { hair: '黑色长直发' }, {})).toEqual({ hair: null });
  });

  it('清空一个原本就没有值的字段什么都不发（发 null 会被 optional() 拒掉）', () => {
    expect(diffMetadata(SPECS, {}, { hair: undefined })).toEqual({});
    expect(diffMetadata(SPECS, {}, {})).toEqual({});
  });

  it('group 内清空发的是嵌套 null，而不是把整个 group 置 null', () => {
    const patch = diffMetadata(SPECS, { appearance: { hair: '黑色长直发' } }, { appearance: {} });
    // `{ appearance: null }` 会连 Agent 写入的 appearance.age / facialFeatures 一起删掉
    expect(patch).toEqual({ appearance: { hair: null } });
    expect(patch.appearance).not.toBeNull();
  });

  it('group 内没有任何改动时不发这个 group', () => {
    const initial = { appearance: { hair: '黑色长直发' } };
    expect(diffMetadata(SPECS, initial, { appearance: { hair: '黑色长直发' } })).toEqual({});
  });

  it('Agent 写入、表单没有暴露的字段不会出现在补丁里', () => {
    // 表单只认 SPECS 里的键；generation 这类键连被检查的机会都没有
    const patch = diffMetadata(SPECS, { generation: { prompt: 'x' } }, { hair: '红色短发' });
    expect(patch).toEqual({ hair: '红色短发' });
    expect(Object.keys(patch)).not.toContain('generation');
  });
});

describe('fieldPaths', () => {
  it('同时给出叶子与 group 的点分路径', () => {
    const paths = fieldPaths(METADATA_SPECS.character);
    expect(paths.has('appearance')).toBe(true);
    expect(paths.has('appearance.hair')).toBe(true);
    expect(paths.has('costume.name')).toBe(true);
  });

  it('生成产物的字段表是空的 → 路径集合也是空的', () => {
    expect(fieldPaths(METADATA_SPECS.image).size).toBe(0);
  });
});

describe('parseFieldErrors', () => {
  const paths = fieldPaths(METADATA_SPECS.character);

  it('把 `字段.子字段: 说明` 解析到对应路径', () => {
    const parsed = parseFieldErrors(
      ['appearance.hair: 字符串长度不能超过 200', 'appearance.age: 应为整数'],
      paths,
    );
    expect(parsed.fieldErrors).toEqual({
      'appearance.hair': '字符串长度不能超过 200',
      'appearance.age': '应为整数',
    });
    expect(parsed.unmatched).toEqual([]);
  });

  it('匹配不上路径的原文进 unmatched，不被丢掉', () => {
    const parsed = parseFieldErrors(
      ['appearanceFields.性别: 类型不匹配', '检查请求体字段名称与类型是否正确'],
      paths,
    );
    expect(parsed.fieldErrors).toEqual({});
    expect(parsed.unmatched).toEqual([
      'appearanceFields.性别: 类型不匹配',
      '检查请求体字段名称与类型是否正确',
    ]);
  });

  it('说明里带冒号也不会被截断', () => {
    const parsed = parseFieldErrors(['appearance.hair: 需要形如「长发：及腰」的描述'], paths);
    expect(parsed.fieldErrors['appearance.hair']).toBe('需要形如「长发：及腰」的描述');
  });
});

describe('标签', () => {
  it('14 类都有中文标签，没有空串', () => {
    for (const type of ASSET_TYPES) {
      expect(ASSET_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
    expect(Object.keys(ASSET_TYPE_LABELS).sort()).toEqual([...ASSET_TYPES].sort());
  });

  it('类型筛选项覆盖全部 14 类', () => {
    expect(ASSET_TYPE_OPTIONS.map((option) => option.value)).toEqual([...ASSET_TYPES]);
  });

  it('只有 7 类创作实体走表单', () => {
    expect(isCreativeAssetType('character')).toBe(true);
    expect(isCreativeAssetType('image')).toBe(false);
    expect(isCreativeAssetType('video')).toBe(false);
  });
});
