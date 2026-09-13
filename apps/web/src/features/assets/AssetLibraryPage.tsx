/**
 * 项目资产库。
 *
 * ── 路由归属 ──
 * `/projects/:projectId/assets`，套 AppShell。资产库是「查阅与维护」型页面，
 * 用户在这里会想要直接回项目列表或去配置页，因此不用工作台那种 100dvh 布局。
 *
 * ── 列表端点为什么是 `/api/assets` 而不是 `/api/projects/:id/assets` ──
 * 实测：前者不传 `status` 时自动排除 `archived`（正是资产库要的默认行为），
 * 后者的**没有状态过滤**，归档资产会混进来；前者的 `q` 还多搜一个 `description`。
 *
 * ── 两种「空」必须分开 ──
 * 「项目里没有资产」与「筛选后没有结果」混成一个，会让人以为数据没了，
 * 而实际上只是筛选条件没清。两套文案、两个不同的主操作。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { EmptyState, ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch } from '../../lib/api.js';
import type { AssetSummary, AssetType, PageBody, Project } from '../../lib/api-types.js';
import { AssetCreateDialog } from './AssetCreateDialog.js';
import { AssetDetailDrawer } from './AssetDetailDrawer.js';
import { ASSET_TYPE_LABELS, ASSET_TYPE_OPTIONS } from './assetLabels.js';
import styles from './AssetLibraryPage.module.css';

/** 每页条数。上限是 200（`paginationSchema`），50 是列表的取舍：够长又不至于一次拉太多 */
const PAGE_SIZE = 50;

/** 搜索防抖时长 */
const SEARCH_DEBOUNCE_MS = 300;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

/**
 * 封面缩略图。图挂了就退回类型标签占位。
 *
 * 不复用 ResultCard 的 `media-health` 体检：那是为了回答「文件还在不在」，
 * 要发一次额外请求；列表里几十行逐个体检代价太大，而**破了就换占位**
 * 已经足够 —— 这一行仍然可点、可辨认。
 */
function CoverThumb({ asset }: { asset: AssetSummary }) {
  const [broken, setBroken] = useState(false);

  if (asset.coverUrl === null || broken) {
    // 首字字形块（角/场/道/服/品/牌/数…），不是图标：图标集里没有 14 类各自的图形，
    // 用同一个通用图标反而分不出类型。右侧的类型标签才是权威指示，这里只负责把
    // 48×48 的方块填成一个看上去是有意为之的东西
    return <span className={styles.coverFallback}>{ASSET_TYPE_LABELS[asset.type].slice(0, 1)}</span>;
  }
  return (
    <img
      className={styles.coverImage}
      src={asset.coverUrl}
      alt=""
      loading="lazy"
      onError={() => {
        setBroken(true);
      }}
    />
  );
}

export function AssetLibraryPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { show: toast } = useToast();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<AssetType | 'all'>('all');
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** 递增即要求重新拉第一页（保存 / 归档 / 新建之后） */
  const [reloadToken, setReloadToken] = useState(0);
  const [projectName, setProjectName] = useState<string | null>(null);

  const selectedId = searchParams.get('asset');
  const filtering = typeFilter !== 'all' || debouncedQuery.trim() !== '';
  /**
   * 页头要不要放「新建资产」主操作。
   *
   * 「项目里还没有资产」那套空态自带一个主操作，页头再放一个同名的 primary，
   * 一屏上就有两个一模一样的主按钮 —— 规范里「一个操作区域只有一个 Primary」
   * 说的正是这种情况。筛选后无结果时**要**保留页头这个：
   * 那时空态的主操作是「清除筛选」，新建入口不该跟着消失。
   */
  const showHeaderCreate = !(state.kind === 'ready' && items.length === 0 && !filtering);

  // 搜索防抖：逐字打请求会把后端打满，也会让列表在打字过程中反复闪
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  const buildUrl = useCallback(
    (targetPage: number): string => {
      const params = new URLSearchParams({
        projectId,
        pageSize: String(PAGE_SIZE),
        page: String(targetPage),
        sortOrder: 'desc',
      });
      if (debouncedQuery.trim() !== '') params.set('q', debouncedQuery.trim());
      if (typeFilter !== 'all') params.set('type', typeFilter);
      return `/api/assets?${params.toString()}`;
    },
    [projectId, debouncedQuery, typeFilter],
  );

  // 第一页：筛选条件或 reloadToken 变化时整体重拉
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const body = await apiFetch<PageBody<AssetSummary>>(buildUrl(1));
        if (cancelled) return;
        setItems(body.items);
        setTotal(body.total);
        setPage(1);
        setHasMore(body.hasMore);
        setState({ kind: 'ready' });
      } catch (err) {
        if (cancelled) return;
        const apiError = err instanceof ApiError ? err : null;
        setState({
          kind: 'error',
          message: apiError?.message ?? '加载资产列表失败。',
          suggestions: apiError?.suggestions ?? [],
          retryable: apiError?.retryable ?? false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildUrl, reloadToken]);

  /*
   * 项目名只是标题的副标题。刻意**不**因为拉不到它就让整页失败：
   * 资产列表能显示才是这条页面存在的意义，项目名拉不到时少显示一段就行。
   * 真正的故障（后端挂了）会由上面的列表请求报出来。
   */
  useEffect(() => {
    let cancelled = false;
    void apiFetch<Project>(`/api/projects/${projectId}`)
      .then((project) => {
        if (!cancelled) setProjectName(project.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const body = await apiFetch<PageBody<AssetSummary>>(buildUrl(next));
      setItems((prev) => [...prev, ...body.items]);
      setTotal(body.total);
      setPage(next);
      setHasMore(body.hasMore);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      toast(apiError?.message ?? '加载更多失败，请重试。', 'error');
    } finally {
      setLoadingMore(false);
    }
  }

  /** 打开详情：**push**，这样浏览器后退键能关掉抽屉 */
  const openAsset = useCallback(
    (id: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('asset', id);
        return next;
      });
    },
    [setSearchParams],
  );

  /** 关闭详情：**replace** 清掉参数，否则后退键会又把它打开 */
  const closeAsset = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('asset');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  /*
   * 深链指向不存在、或不属于本项目的资产。
   * 提示**一次**（toast 不常驻），然后把参数清掉退回列表 ——
   * 静默忽略会让人以为链接坏了却说不出为什么。
   */
  const handleMissing = useCallback(() => {
    toast('这个资产不存在，或者不属于当前项目。', 'error');
    closeAsset();
  }, [closeAsset, toast]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setTypeFilter('all');
  }, []);

  function renderBody(): ReactNode {
    if (state.kind === 'loading') return <SkeletonLines lines={5} />;
    if (state.kind === 'error') {
      return (
        <ErrorState
          title="加载资产列表失败"
          reason={state.message}
          {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
          {...(state.retryable
            ? {
                onRetry: () => {
                  setReloadToken((token) => token + 1);
                },
              }
            : {})}
        />
      );
    }
    if (items.length === 0) {
      // 两种「空」：项目里没有资产 / 筛选后没有结果
      return filtering ? (
        <EmptyState
          icon="folder"
          title="没有匹配的资产"
          description={`当前条件：${[
            typeFilter === 'all' ? null : `类型：${ASSET_TYPE_LABELS[typeFilter]}`,
            debouncedQuery.trim() === '' ? null : `关键词：「${debouncedQuery.trim()}」`,
          ]
            .filter((part) => part !== null)
            .join(' · ')}。清掉条件就能看到全部资产。`}
          action={<Button onClick={clearFilters}>清除筛选</Button>}
        />
      ) : (
        <EmptyState
          icon="folder"
          title="这个项目还没有资产"
          description="角色、场景、品牌、产品都可以先建在这里，之后在对话里用 @名字 直接引用。Agent 生成的内容也会自动入库。"
          action={
            <Button
              variant="primary"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              新建资产
            </Button>
          }
        />
      );
    }
    return (
      <>
        <ul className={styles.list}>
          {items.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                className={styles.item}
                data-asset-id={asset.id}
                onClick={() => {
                  openAsset(asset.id);
                }}
              >
                <span className={styles.cover}>
                  <CoverThumb asset={asset} />
                </span>
                <span className={styles.itemBody}>
                  <span className={styles.itemName}>{asset.name}</span>
                  <span className={styles.itemMeta}>
                    <span className={styles.typeChip}>{ASSET_TYPE_LABELS[asset.type]}</span>
                    {/* slug 要显式展示：@slug 才是用户实际会打的东西 */}
                    <span className={styles.slug}>@{asset.slug}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hasMore ? (
          <div className={styles.footer}>
            <Button
              loading={loadingMore}
              onClick={() => {
                void loadMore();
              }}
            >
              加载更多
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>资产</h1>
          <p className={styles.subtitle}>
            {projectName ?? '当前项目'} · 共 {total} 项
          </p>
        </div>
        <div className={styles.headerActions}>
          <Link className={styles.backLink} to={`/projects/${projectId}`}>
            返回工作台
          </Link>
          {showHeaderCreate ? (
            <Button
              variant="primary"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              新建资产
            </Button>
          ) : null}
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Field label="搜索资产" htmlFor="asset-search">
            <input
              id="asset-search"
              type="search"
              value={query}
              placeholder="按名称、引用名或说明搜索"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </Field>
        </div>
        <div className={styles.filters} role="group" aria-label="按类型筛选">
          <button
            type="button"
            className={`${styles.filterChip} ${typeFilter === 'all' ? styles.filterChipActive : ''}`}
            aria-pressed={typeFilter === 'all'}
            onClick={() => {
              setTypeFilter('all');
            }}
          >
            全部
          </button>
          {ASSET_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.filterChip} ${
                typeFilter === option.value ? styles.filterChipActive : ''
              }`}
              aria-pressed={typeFilter === option.value}
              onClick={() => {
                setTypeFilter(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {renderBody()}

      <AssetCreateDialog
        open={createOpen}
        projectId={projectId}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={() => {
          setCreateOpen(false);
          toast('资产已创建。', 'success');
          setReloadToken((token) => token + 1);
        }}
      />

      <AssetDetailDrawer
        assetId={selectedId}
        projectId={projectId}
        onClose={closeAsset}
        onMissing={handleMissing}
        onChanged={() => {
          setReloadToken((token) => token + 1);
        }}
      />
    </div>
  );
}
