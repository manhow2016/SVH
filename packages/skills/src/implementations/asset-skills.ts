/**
 * 资产类技能：asset.create / asset.update
 *
 * 技术文档第 81 条明确要求 Phase 2 先实现这两个 —— 它们是所有生成类技能的
 * 下游落点：无论模型产出什么，最终都要变成项目资产。
 *
 * 设计要点：
 * - 输入契约与目录中的 `inputSchema` 保持一致
 * - 走 `deps.assets` 端口而非直接访问数据库
 * - 产出结构化结果卡片数据，供 Agent UI 直接渲染（技术文档第 12 条）
 */
import {
  ValidationError,
  type CardAction,
  type ResultCardPayload,
} from '@svh/domain';

import type { SkillExecutionContext } from '../runtime/ports.js';
import type { SkillImplementation, SkillExecutionOutput } from '../runtime/registry.js';

/* -------------------------------------------------------------------------- */
/* asset.create                                                               */
/* -------------------------------------------------------------------------- */

interface AssetCreateInput {
  type: string;
  name: string;
  slug?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

/** 资产类型的中文名，用于结果卡片文案 */
const TYPE_LABELS: Record<string, string> = {
  character: '角色',
  digital_human: '数字人',
  product: '产品',
  brand: '品牌',
  scene: '场景',
  prop: '道具',
  costume: '服装',
  image: '图片',
  video: '视频',
  audio: '音频',
  voice: '音色',
  music: '音乐',
  logo: '标识',
  font: '字体',
};

function normalizeAssetCreate(input: Record<string, unknown>): AssetCreateInput {
  const type = input.type;
  const name = input.name;
  if (typeof type !== 'string' || type.length === 0) {
    throw new ValidationError('asset.create 需要 type 参数');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('asset.create 需要 name 参数');
  }
  return {
    type,
    name,
    ...(typeof input.slug === 'string' ? { slug: input.slug } : {}),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(isPlainObject(input.metadata) ? { metadata: input.metadata } : {}),
    ...(Array.isArray(input.tags) ? { tags: input.tags.filter((t): t is string => typeof t === 'string') } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const assetCreateSkill: SkillImplementation<AssetCreateInput> = {
  id: 'asset.create',
  normalizeInput: normalizeAssetCreate,

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(10, '准备创建资产');
    await ctx.step('校验资产数据', { type: input.type, name: input.name });

    await ctx.reportProgress(40, `正在创建${TYPE_LABELS[input.type] ?? '资产'}`);
    const created = await ctx.deps.assets.create({
      projectId: ctx.projectId,
      type: input.type,
      name: input.name,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(ctx.contentId != null ? { sourceContentId: ctx.contentId } : {}),
      changelog: '由 Agent 创建',
    });

    await ctx.step('写入首版快照', { assetId: created.id, version: created.version });
    await ctx.reportProgress(100, '资产已创建');

    const typeLabel = TYPE_LABELS[input.type] ?? '资产';
    const card: ResultCardPayload = {
      type: 'result_card',
      title: `${typeLabel}已创建`,
      category: 'asset',
      subtitle: input.name,
      attributes: buildAttributes(input),
      media: [],
      assetId: created.id,
      actions: [
        { id: 'view', label: '查看', kind: 'secondary' },
        { id: 'regenerate', label: '重新生成', kind: 'secondary', message: `重新生成「${input.name}」` },
        { id: 'adopt', label: '采用', kind: 'primary', message: `采用「${input.name}」` },
      ] satisfies CardAction[],
    };

    return {
      output: {
        assetId: created.id,
        slug: created.slug,
        version: created.version,
        type: input.type,
        name: input.name,
      },
      assetIds: [created.id],
      summary: `已创建${typeLabel}「${input.name}」，可用 @${created.slug} 引用。`,
      card: card as unknown as Record<string, unknown>,
    };
  },
};

/** 把资产的关键字段整理成卡片属性行 */
function buildAttributes(input: AssetCreateInput): Array<[string, string]> {
  const rows: Array<[string, string]> = [['类型', TYPE_LABELS[input.type] ?? input.type]];
  const metadata = input.metadata ?? {};

  // 角色 / 数字人：展示外观要点，让用户一眼确认是否符合预期
  const appearance = metadata.appearance;
  if (isPlainObject(appearance)) {
    const hair = appearance.hair;
    const age = appearance.age;
    const gender = appearance.gender;
    if (typeof hair === 'string') rows.push(['发型', hair]);
    if (typeof age === 'number') rows.push(['年龄', String(age)]);
    if (typeof gender === 'string') rows.push(['性别', genderLabel(gender)]);
  }
  if (typeof metadata.role === 'string') rows.push(['定位', metadata.role]);
  if (typeof metadata.slogan === 'string') rows.push(['口号', metadata.slogan]);
  if (typeof metadata.category === 'string') rows.push(['品类', metadata.category]);
  if (typeof metadata.timeOfDay === 'string') rows.push(['时间', metadata.timeOfDay]);

  return rows.slice(0, 6);
}

function genderLabel(value: string): string {
  switch (value) {
    case 'male':
      return '男';
    case 'female':
      return '女';
    case 'other':
      return '其他';
    default:
      return '未指定';
  }
}

/* -------------------------------------------------------------------------- */
/* asset.update                                                               */
/* -------------------------------------------------------------------------- */

interface AssetUpdateInput {
  assetId: string;
  patch: {
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    status?: 'active' | 'draft' | 'archived';
  };
  changelog?: string;
}

function normalizeAssetUpdate(input: Record<string, unknown>): AssetUpdateInput {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    throw new ValidationError('asset.update 需要 assetId 参数');
  }
  if (!isPlainObject(input.patch)) {
    throw new ValidationError('asset.update 需要 patch 参数（对象）');
  }

  const raw = input.patch;
  const patch: AssetUpdateInput['patch'] = {};
  if (typeof raw.name === 'string') patch.name = raw.name;
  if (typeof raw.description === 'string') patch.description = raw.description;
  if (isPlainObject(raw.metadata)) patch.metadata = raw.metadata;
  if (Array.isArray(raw.tags)) {
    patch.tags = raw.tags.filter((t): t is string => typeof t === 'string');
  }
  if (raw.status === 'active' || raw.status === 'draft' || raw.status === 'archived') {
    patch.status = raw.status;
  }

  return {
    assetId: input.assetId,
    patch,
    ...(typeof input.changelog === 'string' ? { changelog: input.changelog } : {}),
  };
}

export const assetUpdateSkill: SkillImplementation<AssetUpdateInput> = {
  id: 'asset.update',
  normalizeInput: normalizeAssetUpdate,

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(20, '正在更新资产');
    await ctx.step('应用变更', {
      assetId: input.assetId,
      fields: Object.keys(input.patch),
    });

    const updated = await ctx.deps.assets.update({
      assetId: input.assetId,
      patch: input.patch,
      ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
    });

    await ctx.reportProgress(100, '资产已更新');

    // 变更说明对用户可见：让他们知道这次改了什么（技术文档第 49 条）
    const changedFields = Object.keys(input.patch);
    const changelog = input.changelog ?? `更新字段：${changedFields.join('、')}`;

    return {
      output: {
        assetId: updated.id,
        version: updated.version,
        changedFields,
      },
      assetIds: [updated.id],
      summary: `资产已更新到 v${updated.version}（${changelog}）。`,
      card: {
        type: 'result_card',
        title: '资产已更新',
        category: 'asset',
        subtitle: `v${updated.version}`,
        attributes: [['变更', changelog]] as Array<[string, string]>,
        media: [],
        assetId: updated.id,
        actions: [
          { id: 'view', label: '查看', kind: 'secondary' },
          { id: 'history', label: '版本历史', kind: 'secondary' },
        ] satisfies CardAction[],
      } as unknown as Record<string, unknown>,
    };
  },
};
