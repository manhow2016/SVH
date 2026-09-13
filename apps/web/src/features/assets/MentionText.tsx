/**
 * 消息正文里的 `@资产`。
 *
 * ── 正则与后端**逐字相同** ──
 * `apps/api/src/core/slug.ts` 的 `parseAssetMentions` 用的是
 * `/@([\w\u4e00-\u9fa5-]+)/gu`。前端用同一条，保证「后端认得的引用」与
 * 「前端可能链接化的引用」是同一批。代价是 `a@b.com` 里的 `@b` 也会被当成
 * 引用 —— 但后端本来就这么解析，只改前端会让「后端认得的引用」点不开。
 *
 * ── 匹配不上就保持纯文本 ──
 * 索引只含项目里**真实存在**、且在前 200 条窗口内的资产。
 * 宁可不可点，也不要链错：一个把 `@张三` 链到李四的链接比没有链接糟得多。
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import styles from './MentionText.module.css';

const MENTION_PATTERN = /@([\w\u4e00-\u9fa5-]+)/gu;

export interface MentionTextProps {
  text: string;
  /** slug → 资产 id */
  assetIndex: ReadonlyMap<string, string>;
  projectId: string;
}

export function MentionText({ text, assetIndex, projectId }: MentionTextProps) {
  // 空索引（还没拉到 / 拉失败）时不做任何解析：降级就是纯文本
  if (assetIndex.size === 0) return <>{text}</>;

  /*
   * 每次都新建正则：带 `g` 的正则带 `lastIndex` 状态，跨渲染复用会从上次的位置
   * 继续匹配，表现为「同一段文字第二次渲染就漏掉了前面的引用」。
   */
  const pattern = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match = pattern.exec(text);

  while (match !== null) {
    const slug = match[1];
    const assetId = slug === undefined ? undefined : assetIndex.get(slug);
    if (slug !== undefined && assetId !== undefined) {
      nodes.push(text.slice(cursor, match.index));
      nodes.push(
        <Link
          key={`${String(match.index)}-${slug}`}
          className={styles.mention}
          to={`/projects/${projectId}/assets?asset=${assetId}`}
        >
          {match[0]}
        </Link>,
      );
      cursor = match.index + match[0].length;
    }
    match = pattern.exec(text);
  }

  // 一个都没命中：整段原样返回，不产生多余的 DOM 层级
  if (nodes.length === 0) return <>{text}</>;

  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
