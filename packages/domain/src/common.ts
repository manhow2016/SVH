/**
 * 通用 Schema 片段：ID、分页、时间戳等跨模块复用的基础结构。
 */
import { z } from 'zod';

/**
 * 领域实体 ID。
 *
 * 默认由 Prisma `@default(cuid())` 生成（cuid2 为小写字母 + 数字），
 * 因此这里只允许 `[a-z0-9]`。
 *
 * 注意：不允许连字符。系统内产生的标识（如 Mock 模型 id）若含 `-`
 * 会被这里拒绝 —— 这是刻意的，避免出现「两种 id 风格混用」。
 */
export const idSchema = z
  .string()
  .min(1, 'ID 不能为空')
  .max(64, 'ID 长度不能超过 64')
  .regex(/^[a-z0-9]+$/i, 'ID 格式非法');

/**
 * 资产 Slug：用户可在 Agent 输入框中通过 `@苏晚` 引用资产。
 * 允许中文、字母、数字、下划线、连字符。
 */
export const slugSchema = z
  .string()
  .min(1, '引用名不能为空')
  .max(64, '引用名长度不能超过 64')
  .regex(/^[\w\u4e00-\u9fa5-]+$/u, '引用名只允许中英文、数字、下划线和连字符');

/** 排序方向 */
export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

/** 分页查询参数 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  sortOrder: sortOrderSchema,
});

export type PaginationInput = z.input<typeof paginationSchema>;
export type PaginationParams = z.output<typeof paginationSchema>;

/** 分页结果包装 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** 构造分页结果 */
export function paginate<T>(
  items: T[],
  total: number,
  params: Pick<PaginationParams, 'page' | 'pageSize'>,
): Paginated<T> {
  const { page, pageSize } = params;
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}

/** 软删除查询开关 */
export const softDeleteFilterSchema = z.object({
  includeArchived: z.coerce.boolean().default(false),
});

/** ISO 8601 时间字符串 */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** 任意 JSON 对象（用于 metadata / payload 等自由字段） */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

/** 时长（秒），支持小数以表达 2.5 秒镜头 */
export const durationSecondsSchema = z.number().positive().max(60 * 60 * 8);

/** 画幅比例 */
export const aspectRatioSchema = z.enum(['9:16', '16:9', '1:1', '4:3', '3:4', '21:9']);

/** 目标平台 */
export const platformSchema = z.enum([
  'douyin',
  'xiaohongshu',
  'kuaishou',
  'wechat_channels',
  'youtube',
  'youtube_shorts',
  'instagram',
  'tiktok',
  'bilibili',
  'generic',
]);

/** 外部文件存储引用（本地磁盘 / S3 / OSS 由 storage 层解释） */
export const storageRefSchema = z.object({
  /** 存储驱动标识，如 local / s3 */
  driver: z.string().min(1),
  /** 驱动内的对象键，如 assets/2026/01/xxx.png */
  key: z.string().min(1),
  /** 可直接访问的 URL（若驱动支持） */
  url: z.string().url().optional(),
  /** 字节大小 */
  size: z.number().int().nonnegative().optional(),
  /** MIME 类型 */
  mimeType: z.string().optional(),
  /** 内容哈希，用于去重 */
  checksum: z.string().optional(),
});

export type StorageRef = z.infer<typeof storageRefSchema>;
