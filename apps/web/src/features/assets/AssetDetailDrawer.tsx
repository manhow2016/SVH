/**
 * 资产详情抽屉。
 *
 * ── 两种形态 ──
 * 创作实体（角色/场景/道具/服装/品牌/产品/数字人）：metadata 可编辑 → 表单
 * 生成产物（图片/视频/音频/音色/音乐/标识/字体）：metadata 是**生成结果**，
 *   只读展示；只允许改 name / description / tags，避免手填出与文件不符的数据
 *
 * ── 只提交 dirty 字段 ──
 * 这是本阶段最要紧的一条：Agent 会往 metadata 里写表单没有的东西
 * （`generation` / `reference_images` / `cues`）。提交整份 = 把它们悄悄抹掉。
 * 因此 metadata 用 `diffMetadata` 产出补丁，通用字段也逐个与初始值比对；
 * 一个字段都没改时**不发请求**（避免平白的版本号增长把真实改动淹掉）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Drawer } from '../../components/Drawer.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch, apiPatch } from '../../lib/api.js';
import type { AssetDetail, AssetUpdateResult } from '../../lib/api-types.js';
import { parseFieldErrors } from './assetErrors.js';
import { ASSET_STATUS_LABELS, ASSET_TYPE_LABELS } from './assetLabels.js';
import { MetadataForm, TagsField } from './metadata/MetadataForm.js';
import {
  GENERAL_FIELD_KEYS,
  METADATA_SPECS,
  diffMetadata,
  fieldPaths,
  isCreativeAssetType,
} from './metadata/specs.js';
import styles from './AssetDetailDrawer.module.css';

export interface AssetDetailDrawerProps {
  /** 要打开的资产 id；`null` 表示关闭 */
  assetId: string | null;
  projectId: string;
  onClose: () => void;
  /** 资产不存在，或不属于本项目。调用方负责清掉深链参数并提示一次 */
  onMissing: () => void;
  /** 保存 / 归档成功后调用，用于刷新列表 */
  onChanged: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; asset: AssetDetail }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

interface Draft {
  name: string;
  slug: string;
  description: string;
  tags: string[];
  coverUrl: string;
  metadata: Record<string, unknown>;
}

interface FormError {
  message: string;
  /** 没能落到具体输入框的原文（含后端给的通用建议） */
  suggestions: string[];
}

function toDraft(asset: AssetDetail): Draft {
  return {
    name: asset.name,
    slug: asset.slug,
    description: asset.description,
    tags: asset.tags,
    coverUrl: asset.coverUrl ?? '',
    metadata: asset.metadata,
  };
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 媒体 metadata 常见键的中文名。表里没有的键**按原样显示** —— 宁可显示得笨，也不能不显示 */
const MEDIA_LABELS: Record<string, string> = {
  width: '宽度',
  height: '高度',
  duration: '时长（秒）',
  format: '格式',
  fps: '帧率',
  sampleRate: '采样率',
  channels: '声道数',
  language: '语言',
  transcript: '文本内容',
  aspectRatio: '画幅比例',
  shotCount: '镜头数',
  cues: '字幕条目',
  generation: '生成信息',
};

/** `generation` 子键的中文名 */
const GENERATION_LABELS: Record<string, string> = {
  modelId: '模型',
  prompt: '提示词',
  negativePrompt: '负向提示词',
  seed: '随机种子',
  steps: '步数',
  guidance: '引导强度',
  skillId: '技能',
  taskId: '任务',
  editedFrom: '编辑自',
  extendedFrom: '延长自',
  extraSeconds: '延长时长（秒）',
  voiceAssetId: '音色资产',
};

function MetaValue({
  value,
  labels,
}: {
  value: unknown;
  labels: Record<string, string>;
}): ReactNode {
  if (Array.isArray(value)) {
    /*
     * 数组只报个数：`cues` 可能有几千条字幕，逐条铺开会把抽屉淹掉。
     * 「共 N 项」已经能回答「这份字幕是不是空的」这个问题。
     */
    return <span>共 {value.length} 项</span>;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span>（空）</span>;
    return (
      <dl className={styles.metaNested}>
        {entries.map(([key, item]) => (
          <MetaRow key={key} label={labels[key] ?? key} value={item} labels={GENERATION_LABELS} />
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function MetaRow({
  label,
  value,
  labels,
}: {
  label: string;
  value: unknown;
  labels: Record<string, string>;
}): ReactNode {
  // 空值不占一行：metadata 里大量可选字段，逐个显示「（未设置）」只会淹没有效信息
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className={styles.metaRow}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={styles.metaValue}>
        <MetaValue value={value} labels={labels} />
      </dd>
    </div>
  );
}

export function AssetDetailDrawer({
  assetId,
  projectId,
  onClose,
  onMissing,
  onChanged,
}: AssetDetailDrawerProps) {
  const { show: toast } = useToast();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<FormError | null>(null);

  /*
   * 回调用 ref 拿，**不进依赖数组**：调用方少写一个 useCallback 的话，
   * `load` 每次渲染都会变，effect 就会变成「每次渲染都重新拉一次详情」的死循环。
   */
  const missingRef = useRef(onMissing);
  useEffect(() => {
    missingRef.current = onMissing;
  }, [onMissing]);

  const load = useCallback(
    async (id: string) => {
      setState({ kind: 'loading' });
      setFormError(null);
      setFieldErrors({});
      setArchiveError(null);
      try {
        const asset = await apiFetch<AssetDetail>(`/api/assets/${id}`);
        /*
         * 深链可以指向任何 id。不属于本项目的资产**不能**在这里打开：
         * 页面是项目作用域的，打开别家的资产会让人以为它属于当前项目。
         * 静默退开更糟 —— 用户会以为链接坏了却看不出为什么。
         */
        if (asset.projectId !== projectId) {
          missingRef.current();
          return;
        }
        setState({ kind: 'ready', asset });
        setDraft(toDraft(asset));
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        // 404 与「资产不存在」是一回事，交给调用方统一处理（清参数 + 提示一次）
        if (apiError?.status === 404) {
          missingRef.current();
          return;
        }
        setState({
          kind: 'error',
          message: apiError?.message ?? '加载资产详情失败。',
          suggestions: apiError?.suggestions ?? [],
          retryable: apiError?.retryable ?? false,
        });
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (assetId === null) {
      setState({ kind: 'loading' });
      setDraft(null);
      setArchiveOpen(false);
      return;
    }
    void load(assetId);
  }, [assetId, load]);

  const creative = state.kind === 'ready' && isCreativeAssetType(state.asset.type);

  /** 后端可能对通用字段报错，它们的路径不在 METADATA_SPECS 里 */
  const knownPaths = useMemo(() => {
    const keys: readonly string[] = creative
      ? GENERAL_FIELD_KEYS
      : ['name', 'description', 'tags'];
    return new Set<string>([
      ...keys,
      ...(state.kind === 'ready' ? fieldPaths(METADATA_SPECS[state.asset.type]) : []),
    ]);
  }, [creative, state]);

  async function save(): Promise<void> {
    if (state.kind !== 'ready' || draft === null || submitting) return;
    const asset = state.asset;
    const isCreative = isCreativeAssetType(asset.type);

    const trimmedName = draft.name.trim();
    if (trimmedName === '') {
      setFieldErrors({ name: '资产名称不能为空' });
      setFormError(null);
      return;
    }

    const body: Record<string, unknown> = {};
    if (trimmedName !== asset.name) body.name = trimmedName;
    // slug 与封面只对创作实体开放：生成产物的这两个字段不该被人手改
    // 比较也走 trim：否则「多打一个尾随空格」会发出一份与原值相同的 slug，平白多一个版本号
    if (isCreative && draft.slug.trim() !== asset.slug) body.slug = draft.slug.trim();
    if (draft.description !== asset.description) body.description = draft.description;
    if (!sameStringList(draft.tags, asset.tags)) body.tags = draft.tags;
    if (isCreative) {
      const currentCover = asset.coverUrl ?? '';
      if (draft.coverUrl.trim() !== currentCover) {
        // 服务端的 coverUrl 是 `.nullable().optional()`：清空要发 null
        body.coverUrl = draft.coverUrl.trim() === '' ? null : draft.coverUrl.trim();
      }
      const patch = diffMetadata(METADATA_SPECS[asset.type], asset.metadata, draft.metadata);
      if (Object.keys(patch).length > 0) body.metadata = patch;
    }

    if (Object.keys(body).length === 0) {
      toast('没有需要保存的改动。', 'info');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      await apiPatch<AssetUpdateResult>(`/api/assets/${asset.id}`, body);
      toast(`已保存「${asset.name}」`, 'success');
      onChanged();
      onClose();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const parsed = parseFieldErrors(apiError?.suggestions ?? [], knownPaths);
      setFieldErrors(parsed.fieldErrors);
      setFormError({
        message: apiError?.message ?? '保存失败。',
        suggestions: parsed.unmatched,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function archive(): Promise<void> {
    if (state.kind !== 'ready' || archiving) return;
    const asset = state.asset;
    setArchiving(true);
    setArchiveError(null);
    try {
      await apiFetch<void>(`/api/assets/${asset.id}`, { method: 'DELETE' });
      setArchiveOpen(false);
      toast(`已归档「${asset.name}」`, 'success');
      onChanged();
      onClose();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      /*
       * 被引用时后端返回 409，并已经说清「被几处内容引用」+ 两条建议。
       * 这段理由必须**原样**显示：换成「删除失败」就把唯一的线索丢了。
       */
      setArchiveError({
        message: apiError?.message ?? '归档失败。',
        suggestions: apiError?.suggestions ?? [],
      });
    } finally {
      setArchiving(false);
    }
  }

  const asset = state.kind === 'ready' ? state.asset : null;

  return (
    <>
      <Drawer
        open={assetId !== null}
        title={asset?.name ?? '资产详情'}
        onClose={onClose}
        width="lg"
      >
        {state.kind === 'loading' ? <SkeletonLines lines={6} /> : null}

        {state.kind === 'error' ? (
          <ErrorState
            title="加载资产详情失败"
            reason={state.message}
            {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
            {...(state.retryable && assetId !== null
              ? {
                  onRetry: () => {
                    void load(assetId);
                  },
                }
              : {})}
          />
        ) : null}

        {asset !== null && draft !== null ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className={styles.summary}>
              <span className={styles.typeTag}>{ASSET_TYPE_LABELS[asset.type]}</span>
              <span>{ASSET_STATUS_LABELS[asset.status]}</span>
              {/* slug 要显式展示：@slug 才是用户实际会打的东西 */}
              <span className={styles.slug}>@{asset.slug}</span>
            </p>

            {formError !== null ? (
              <div className={styles.banner} role="alert">
                <Icon name="alert" className={styles.bannerIcon} />
                <div className={styles.bannerText}>
                  <span>{formError.message}</span>
                  {formError.suggestions.length > 0 ? (
                    <ul className={styles.bannerList}>
                      {formError.suggestions.map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : null}

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>基本信息</h3>
              <div className={styles.general}>
                <Field
                  label="名称"
                  htmlFor="asset-detail-name"
                  {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
                >
                  <input
                    id="asset-detail-name"
                    type="text"
                    value={draft.name}
                    disabled={submitting}
                    onChange={(event) => {
                      setDraft({ ...draft, name: event.target.value });
                    }}
                  />
                </Field>

                {creative ? (
                  <Field
                    label="引用名"
                    htmlFor="asset-detail-slug"
                    helper="在对话里用 @引用名 指定它"
                    {...(fieldErrors.slug !== undefined ? { error: fieldErrors.slug } : {})}
                  >
                    <input
                      id="asset-detail-slug"
                      type="text"
                      value={draft.slug}
                      disabled={submitting}
                      onChange={(event) => {
                        setDraft({ ...draft, slug: event.target.value });
                      }}
                    />
                  </Field>
                ) : null}

                <Field
                  label="说明"
                  htmlFor="asset-detail-description"
                  {...(fieldErrors.description !== undefined
                    ? { error: fieldErrors.description }
                    : {})}
                >
                  <textarea
                    id="asset-detail-description"
                    rows={2}
                    value={draft.description}
                    disabled={submitting}
                    onChange={(event) => {
                      setDraft({ ...draft, description: event.target.value });
                    }}
                  />
                </Field>

                <TagsField
                  label="标签"
                  htmlFor="asset-detail-tags"
                  id="asset-detail-tags"
                  value={draft.tags}
                  disabled={submitting}
                  helper="回车添加一项"
                  {...(fieldErrors.tags !== undefined ? { error: fieldErrors.tags } : {})}
                  onChange={(next) => {
                    setDraft({ ...draft, tags: next });
                  }}
                />

                {creative ? (
                  <Field
                    label="封面图地址"
                    htmlFor="asset-detail-cover"
                    helper="图片直链。留空则列表里用类型标签占位"
                    {...(fieldErrors.coverUrl !== undefined ? { error: fieldErrors.coverUrl } : {})}
                  >
                    <input
                      id="asset-detail-cover"
                      type="text"
                      value={draft.coverUrl}
                      disabled={submitting}
                      onChange={(event) => {
                        setDraft({ ...draft, coverUrl: event.target.value });
                      }}
                    />
                  </Field>
                ) : null}
              </div>
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>元数据</h3>
              {creative ? (
                <MetadataForm
                  specs={METADATA_SPECS[asset.type]}
                  value={draft.metadata}
                  onChange={(next) => {
                    setDraft({ ...draft, metadata: next });
                  }}
                  errors={fieldErrors}
                  disabled={submitting}
                  idPrefix="asset-detail"
                />
              ) : (
                <>
                  <p className={styles.hint}>
                    这些数据由生成链路写入，不提供手填 —— 手填的值会与实际文件不符。
                  </p>
                  {Object.keys(asset.metadata).length === 0 ? (
                    <p className={styles.hint}>这份资产还没有元数据。</p>
                  ) : (
                    <dl className={styles.metaList}>
                      {Object.entries(asset.metadata).map(([key, value]) => (
                        <MetaRow
                          key={key}
                          label={MEDIA_LABELS[key] ?? key}
                          value={value}
                          labels={GENERATION_LABELS}
                        />
                      ))}
                    </dl>
                  )}
                </>
              )}
            </section>

            {asset.files.length > 0 ? (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>文件（{asset.files.length}）</h3>
                <ul className={styles.fileList}>
                  {asset.files.map((file) => (
                    <li className={styles.fileItem} key={`${file.driver}:${file.key}`}>
                      {file.url !== undefined ? (
                        <a className={styles.fileLink} href={file.url} target="_blank" rel="noreferrer">
                          {file.key}
                        </a>
                      ) : (
                        <span>{file.key}</span>
                      )}
                      <span className={styles.fileMeta}>
                        {file.mimeType ?? file.driver}
                        {file.size !== undefined ? ` · ${formatSize(file.size)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className={styles.actions}>
              <Button
                variant="danger"
                disabled={submitting}
                onClick={() => {
                  setArchiveError(null);
                  setArchiveOpen(true);
                }}
              >
                归档
              </Button>
              <Button variant="primary" type="submit" loading={submitting}>
                保存
              </Button>
            </div>
          </form>
        ) : null}
      </Drawer>

      <Dialog
        open={archiveOpen}
        title={`归档「${asset?.name ?? ''}」`}
        onClose={() => {
          setArchiveOpen(false);
        }}
        footer={
          <div className={styles.confirmFooter}>
            <Button
              onClick={() => {
                setArchiveOpen(false);
              }}
              disabled={archiving}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={archiving}
              onClick={() => {
                void archive();
              }}
            >
              确认归档
            </Button>
          </div>
        }
      >
        <p>
          归档是软删除：资产会被标记为「已归档」，从默认列表里消失，历史记录保留。
        </p>
        <p>
          归档后，引用它的内容将不再显示该资产。若它正在被内容引用，服务端会拒绝这次归档
          并说明被哪些内容引用。
        </p>
        {archiveError !== null ? (
          <div className={styles.banner} role="alert">
            <Icon name="alert" className={styles.bannerIcon} />
            <div className={styles.bannerText}>
              <span>{archiveError.message}</span>
              {archiveError.suggestions.length > 0 ? (
                <ul className={styles.bannerList}>
                  {archiveError.suggestions.map((suggestion) => (
                    <li key={suggestion}>{suggestion}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
