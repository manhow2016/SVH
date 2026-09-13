import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../../../components/Button.js';
import { Icon } from '../../../components/Icon.js';
import { apiFetch } from '../../../lib/api.js';
import type {
  AssetMediaHealth,
  CardAction,
  CardMedia,
  ResultCardPayload,
} from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface ResultCardProps {
  payload: ResultCardPayload;
  onAction: (action: CardAction) => void;
  /**
   * 深链所需。**刻意可选**：`renderers.test.tsx` 直接渲染这个组件、
   * 外面没有 Router，渲染 `<Link>` 会直接抛错；而且缺 projectId 时
   * 渲染一个 `/projects//assets?asset=x` 的坏链接比没有链接更糟。
   */
  projectId?: string;
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
function MediaItem({
  item,
  url,
  assetId,
}: {
  item: CardMedia;
  url: string;
  /** 产出这份媒体的资产；没有就无法体检，只能给中性文案 */
  assetId: string | null;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  /** `null` = 还没结论（体检没回来、或这份媒体不在我们手里） */
  const [diagnosis, setDiagnosis] = useState<'missing' | 'unreadable' | null>(null);

  /**
   * 媒体打不开时的处置。
   *
   * 浏览器只给一个 `error`，分不出「文件没了」与「文件在但解不了码」——
   * 这两件事的处置方式完全不同：前者重新生成就能补回来，后者重跑大概率
   * 还是同样结果。产物落盘之后服务端能查磁盘，所以这里去问一次。
   *
   * 体检失败**不**影响已经显示的降级说明：中性文案本身是准确的，
   * 拿不到更细的结论时不该把一个错误换成一个更含糊的错误。
   */
  const markFailed = (): void => {
    setFailed(true);
    if (assetId === null) return;
    void apiFetch<AssetMediaHealth>(`/api/assets/${assetId}/media-health`)
      .then((health) => {
        const entry = health.items.find((x) => x.url === url) ?? health.items[0];
        if (entry?.exists === false) setDiagnosis('missing');
        else if (entry?.exists === true) setDiagnosis('unreadable');
      })
      .catch(() => undefined);
  };

  return (
    <figure className={shared.mediaItem}>
      {failed ? (
        <div className={shared.mediaFailed} role="note">
          <Icon name="alert" className={shared.mediaFailedIcon} />
          {diagnosis === 'missing' ? (
            <>
              <span>媒体已经不在了 —— 这次生成是成功的，但那份文件找不到了。</span>
              <span>重新生成一次可以补回来。</span>
            </>
          ) : diagnosis === 'unreadable' ? (
            <>
              <span>媒体打不开 —— 生成是成功的，文件也还在存储里。</span>
              <span>是浏览器解不了它（格式或编码问题），重新生成大概率是同样结果。</span>
            </>
          ) : (
            <>
              <span>媒体打不开 —— 这次生成是成功的。</span>
              {/*
                体检没结论时把两种可能都列出来，不替用户下判断。
                `exists: null` 说明这份媒体还在 provider 手里（remote 引用），
                我们本来就无从判定它还在不在。
              */}
              <span>可能是文件已失效或取不回来，也可能是格式不被浏览器支持。</span>
            </>
          )}
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

export function ResultCard({ payload, onAction, projectId }: ResultCardProps) {
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
            <MediaItem
              key={keyOf(item, index)}
              item={item}
              url={item.url ?? ''}
              // 单条媒体自带 assetId 更精确；没有就用卡片级的（一张卡通常一个资产）
              assetId={item.assetId ?? payload.assetId ?? null}
            />
          ))}
        </div>
      ) : null}

      {/*
        资产深链：`assetId` 以前只是数据 —— 用户看得见卡片，却点不开对应的资产。
      */}
      {payload.assetId !== undefined && projectId !== undefined && projectId !== '' ? (
        <p className={shared.assetLinkRow}>
          <Link
            className={shared.assetLink}
            to={`/projects/${projectId}/assets?asset=${payload.assetId}`}
          >
            查看资产详情
          </Link>
        </p>
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
