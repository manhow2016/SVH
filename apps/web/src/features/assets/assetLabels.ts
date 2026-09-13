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

/**
 * 枚举型字段的下拉选项。
 *
 * 取值必须与 `packages/domain/src/asset.ts` 里的 `z.enum([...])` **完全一致**，
 * 多一个少一个都会被契约测试抓到（它比对的是 `ZodEnum.options`）。
 * `''` 这个空值不在表里 —— 它由渲染器统一加上，表示「未设置」。
 *
 * 注意：`metadata/specs.ts` 里还有一份**内联的副本**。契约测试用编译器 API
 * 读字段表，只认静态字面量，`options` 写不得变量引用，所以那份副本 import
 * 不到这里来。改动枚举值时两处一起改：契约测试比对的是 specs.ts 里那份，
 * 这里的这一份没有测试盯着。
 */
export const GENDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
  { value: 'other', label: '其他' },
  { value: 'unspecified', label: '不指定' },
];

/** `digital_human.motion.mode` 的驱动方式 */
export const MOTION_MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'talking_head', label: '口播（只动头肩）' },
  { value: 'half_body', label: '半身动作' },
  { value: 'full_body', label: '全身动作' },
];
