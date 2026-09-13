/**
 * 资产相关的中文标签。
 *
 * ── 为什么这里有一份 ASSET_TYPE_LABELS，而 `@svh/domain` 里也有一份 ──
 * `apps/web` 刻意不依赖 `@svh/domain`（会把 Prisma / Fastify 拉进 bundle），
 * 所以标签只能在前端再声明一遍。这份副本**不是**靠自觉维护的：
 * `apps/api/test/asset-form-contract.test.ts` 会把它与 domain 的
 * `ASSET_TYPE_LABELS` 逐字比对，改了一边没改另一边，测试立刻失败。
 */
import {
  ASSET_TYPES,
  CREATIVE_ASSET_TYPES,
  type AssetStatus,
  type AssetType,
  type CreativeAssetType,
} from '../../lib/api-types.js';

/** 资产类型的中文名（列表、筛选、创建对话框、详情抽屉共用） */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
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

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  active: '生效中',
  draft: '草稿',
  archived: '已归档',
};

/** 类型筛选按钮的顺序：先创作实体，后生成产物，与 ASSET_TYPES 的声明顺序一致 */
export const ASSET_TYPE_OPTIONS: ReadonlyArray<{ value: AssetType; label: string }> =
  ASSET_TYPES.map((type) => ({ value: type, label: ASSET_TYPE_LABELS[type] }));

/** 创建对话框里可选的类型（只有 7 类创作实体） */
export const CREATABLE_TYPE_OPTIONS: ReadonlyArray<{ value: CreativeAssetType; label: string }> =
  CREATIVE_ASSET_TYPES.map((type) => ({ value: type, label: ASSET_TYPE_LABELS[type] }));

/*
 * 枚举型字段的下拉选项**不在这里**，它们定义在 `metadata/specs.ts` 里。
 * 理由：`specs.ts` 是「可静态解析」的 —— 契约测试只解析同一个文件里的顶层
 * 常量，跨文件 import 的引用解析不了。把选项放在签名旁边，既不产生死导出，
 * 也不用把同一份选项抄两遍。
 */
