import { Button } from '../../../components/Button.js';
import type { CardAction, CardMedia, ResultCardPayload } from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface ResultCardProps {
  payload: ResultCardPayload;
  onAction: (action: CardAction) => void;
}

/**
 * 操作语义 → 按钮优先级。
 *
 * primary 只给「采用」这类主操作；reply 是「再聊一句」，属于普通操作。
 */
function variantOf(action: CardAction): 'primary' | 'secondary' | 'danger' {
  if (action.kind === 'primary') return 'primary';
  if (action.kind === 'danger') return 'danger';
  return 'secondary';
}

/**
 * 图片的替代文本。
 *
 * 没有 caption 时**不能**留空：空 alt 的语义是「这张图是纯装饰」，
 * 而结果卡里的图恰恰是这次生成的产物本身。读屏用户需要知道这里有内容。
 */
function altOf(item: CardMedia): string {
  return item.caption ?? '生成结果';
}

/** 只有真的能渲染出内容的媒体项才值得占一个格子 */
function renderable(item: CardMedia): boolean {
  return item.url !== undefined;
}

/** 媒体项的稳定 key：优先 assetId，其次 url，最后退化为下标 */
function keyOf(item: CardMedia, index: number): string {
  return item.assetId ?? item.url ?? `${item.kind}-${String(index)}`;
}

export function ResultCard({ payload, onAction }: ResultCardProps) {
  const media = payload.media.filter(renderable);
  const attributes = payload.attributes ?? [];

  return (
    <section className={shared.card} aria-label={payload.title}>
      <header className={shared.header}>
        <h3 className={shared.title}>{payload.title}</h3>
        {payload.subtitle !== undefined ? (
          <p className={shared.subtitle}>{payload.subtitle}</p>
        ) : null}
      </header>

      {attributes.length > 0 ? (
        <dl className={shared.attributes}>
          {attributes.map(([label, value]) => (
            // display: contents 让 dt/dd 直接落进网格的两列，不破坏 dl 的语义
            <div key={`${label}-${value}`} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {media.length > 0 ? (
        <div className={shared.media}>
          {media.map((item, index) => (
            <figure key={keyOf(item, index)} className={shared.mediaItem}>
              {item.kind === 'image' && item.url !== undefined ? (
                <img src={item.url} alt={altOf(item)} loading="lazy" />
              ) : null}
              {item.kind === 'video' && item.url !== undefined ? (
                <video src={item.url} controls preload="metadata" />
              ) : null}
              {item.kind === 'audio' && item.url !== undefined ? (
                <audio src={item.url} controls preload="metadata" />
              ) : null}
              {item.caption !== undefined ? (
                <figcaption className={shared.caption}>{item.caption}</figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}

      {payload.actions.length > 0 ? (
        <div className={shared.actions}>
          {payload.actions.map((action) => (
            <Button key={action.id} variant={variantOf(action)} onClick={() => onAction(action)}>
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
