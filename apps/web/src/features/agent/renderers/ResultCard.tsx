import { useState, type ReactElement } from 'react';

import { Button } from '../../../components/Button.js';
import { Icon } from '../../../components/Icon.js';
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

/**
 * 单个媒体项。
 *
 * ── 为什么要单独成组件并接住 `onError` ──
 * `media[].url` 指向存储（本地盘或远端）。文件被清理、链接过期、存储不可用时，
 * `<img>` 只会渲染成一张破图，`<video>` / `<audio>` 停在无法播放的状态 ——
 * 界面既不说明「生成成功了、只是这份媒体打不开」，也不给下一步，
 * 用户会把它读成「这次生成失败了」，于是白花一次生成去重跑。
 *
 * ── 措辞为什么是「打不开」而不是「取不回来」 ──
 * `error` 事件**同时**覆盖两种原因：
 *   ① 取不回来 —— 404、网络中断、被拦；
 *   ② 取回来了但用不了 —— 字节到了却解不了码 / 格式不被浏览器支持。
 * 从 `error` 本身分不出是哪种（`MediaError.code` 只在 `<video>/<audio>` 上有，
 * 且各家实现不一致）。真机上就撞到过 ②：桩服务把一段文本标成 `video/mp4` 返回，
 * HTTP 200、字节完整，`<video>` 照样报错。
 * 所以文案只断言确定的事（生成是成功的、这份媒体打不开），
 * 把两种可能都列出来，不替用户下结论。
 *
 * **原始地址**要露出来：排查的人第一眼要看的就是它指向哪里。
 */
function MediaItem({ item, url }: { item: CardMedia; url: string }): ReactElement {
  const [failed, setFailed] = useState(false);
  const markFailed = (): void => {
    setFailed(true);
  };

  return (
    <figure className={shared.mediaItem}>
      {failed ? (
        <div className={shared.mediaFailed} role="note">
          <Icon name="alert" className={shared.mediaFailedIcon} />
          <span>媒体打不开 —— 这次生成是成功的。</span>
          <span>可能是文件已失效或取不回来，也可能是格式不被浏览器支持。</span>
          <code className={shared.mediaFailedUrl}>{url}</code>
        </div>
      ) : (
        <>
          {item.kind === 'image' ? (
            <img src={url} alt={altOf(item)} loading="lazy" onError={markFailed} />
          ) : null}
          {item.kind === 'video' ? (
            <video src={url} controls preload="metadata" onError={markFailed} />
          ) : null}
          {item.kind === 'audio' ? (
            <audio src={url} controls preload="metadata" onError={markFailed} />
          ) : null}
        </>
      )}
      {item.caption !== undefined ? (
        <figcaption className={shared.caption}>{item.caption}</figcaption>
      ) : null}
    </figure>
  );
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
            <MediaItem key={keyOf(item, index)} item={item} url={item.url ?? ''} />
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
