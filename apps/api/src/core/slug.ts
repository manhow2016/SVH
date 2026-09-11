/**
 * 资产 Slug 生成
 *
 * 用途：用户在 Agent 输入框中用 `@苏晚` 引用资产（技术文档第 13 条），
 * 因此资产需要一个**人类可读且项目内唯一**的引用名。
 *
 * 与常见的 URL slug 不同，这里**保留中文**：目标不是 URL 美观，
 * 而是让用户能用母语直接引用（`@苏晚` 而不是 `@character_001`）。
 */
import { slugSchema } from '@svh/domain';

/**
 * 把资产名称规范化为 slug。
 *
 * 规则：
 * - 保留中文、字母、数字
 * - 空格与其它符号统一折叠为单个连字符
 * - 去掉首尾连字符
 * - 超长时截断到 48 字符（为去重后缀留出空间）
 */
export function slugifyAssetName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[\s\u3000]+/gu, '-')
    // 保留中文、字母、数字、连字符、下划线，其余（标点、emoji）一律折叠为连字符
    .replace(/[^\w\u4e00-\u9fa5-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  const truncated = normalized.slice(0, 48).replace(/-+$/g, '');

  // 极端情况：名称全是标点导致 slug 为空，退化为带时间戳的通用名
  if (truncated.length === 0) {
    return `asset-${Date.now().toString(36)}`;
  }

  return truncated;
}

/**
 * 在项目内生成唯一 slug。
 *
 * 冲突时追加 `-2`、`-3`…… 而不是随机串，保持可读性
 * （用户看到 `@苏晚-2` 比 `@苏晚-a3f9` 更容易理解发生了什么）。
 *
 * @param base 期望的 slug（通常来自 slugifyAssetName）
 * @param exists 判定某 slug 是否已存在的函数
 */
export async function ensureUniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  // 先把 base 截短，给后缀留空间，保证最终长度不超过 slugSchema 的 64 上限
  const root = base.slice(0, 56);
  let candidate = root;
  let suffix = 1;

  // 上限保护：避免极端情况下无限循环
  while (await exists(candidate)) {
    suffix += 1;
    if (suffix > 1000) {
      candidate = `${root.slice(0, 48)}-${Date.now().toString(36)}`;
      break;
    }
    candidate = `${root}-${suffix}`;
  }

  return slugSchema.parse(candidate);
}

/**
 * 解析用户输入中的 @引用。
 *
 * 供 Agent 输入框使用：把 `让 @苏晚 穿红色衣服，在 @长安城 的雨夜里走路`
 * 解析为引用名列表 `['苏晚', '长安城']`。
 *
 * 注意：这里只做**文本解析**，不做资产查找 —— 查找由调用方按项目范围完成，
 * 避免解析层依赖数据库。
 */
export function parseAssetMentions(text: string): string[] {
  const mentions: string[] = [];
  // @ 后跟中英文、数字、下划线、连字符
  const pattern = /@([\w\u4e00-\u9fa5-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    if (name !== undefined && !mentions.includes(name)) {
      mentions.push(name);
    }
  }
  return mentions;
}

/**
 * 解析 `/技能` 指令。
 *
 * 供 Agent 输入框使用：把 `/创作广告` 解析为技能别名。
 */
export function parseSkillCommand(text: string): string | null {
  const match = /^\s*\/([\w\u4e00-\u9fa5-]+)/u.exec(text);
  return match?.[1] ?? null;
}
