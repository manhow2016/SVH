/**
 * 新建资产对话框：先选类型，再填表单。
 *
 * ── 为什么是两步 ──
 * 14 类资产的字段表互不相同。把类型选择塞进表单顶部，用户选完类型会看到
 * 一张**变了样**的表单，字段位置整体跳动。分开两步，第二步的标题就是
 * 「新建角色」，用户始终知道自己在填什么。
 *
 * ── 为什么只提交填过的字段 ──
 * `slug` / `coverUrl` 留空时不发（而不是发空串）；metadata 用
 * `diffMetadata(specs, {}, values)` 过滤，只保留用户真的碰过的键。
 * 没碰过的键发 `null` 会被 `z.optional()` 拒掉 —— 它只接受 `undefined`。
 *
 * ── 失败时保留输入 ──
 * 提交失败只设置错误状态，**不动**任何输入 state。用户可能刚填了十几个字段，
 * 一次 400 就清空是不可接受的。
 */
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { ApiError, apiPost } from '../../lib/api.js';
import type { AssetDetail, CreativeAssetType } from '../../lib/api-types.js';
import { parseFieldErrors } from './assetErrors.js';
import { CREATABLE_TYPE_OPTIONS } from './assetLabels.js';
import { MetadataForm, TagsField } from './metadata/MetadataForm.js';
import {
  GENERAL_FIELD_KEYS,
  METADATA_SPECS,
  diffMetadata,
  fieldPaths,
} from './metadata/specs.js';
import styles from './AssetCreateDialog.module.css';

export interface AssetCreateDialogProps {
  open: boolean;
  projectId: string;
  /** 预填名称（来自「项目里还没有 @X」的「现在新建」） */
  initialName?: string;
  onClose: () => void;
  /** 创建成功。刷新列表 / 重建资产索引 / 弹提示都由调用方负责 */
  onCreated: (asset: AssetDetail) => void;
}

interface FormError {
  message: string;
  /** 没能落到具体输入框的原文（含后端给的通用建议） */
  suggestions: string[];
}

export function AssetCreateDialog({
  open,
  projectId,
  initialName = '',
  onClose,
  onCreated,
}: AssetCreateDialogProps) {
  const [type, setType] = useState<CreativeAssetType | null>(null);
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [coverUrl, setCoverUrl] = useState('');
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /*
   * 每次重新打开都从干净状态开始。
   *
   * ── 依赖为什么**只有** `open`，没有 `initialName` ──
   * 打开动作本身就会让 `open` 从 false 变 true，而「现在新建」是在同一个点击里
   * 既设 `initialName` 又打开对话框的，所以那一次渲染里 `initialName` 已经是新值，
   * 闭包读到的是对的 —— 把它放进依赖并不会让预填更准。
   *
   * 反过来，放进依赖会带来一条**破坏性**路径：对话框已经打开时只要 `initialName`
   * 变一次，用户填了一半的内容会被全部清空，而且 `setSubmitting(false)`
   * 会在请求还在飞的时候把「创建」重新点亮，防连点也跟着失效。
   * 当前调用方不会这么用，但「靠调用方小心」不是约束 —— 代码本身不该留这个雷。
   */
  useEffect(() => {
    if (!open) return;
    setType(null);
    setName(initialName);
    setSlug('');
    setDescription('');
    setTags([]);
    setCoverUrl('');
    setMetadata({});
    setSubmitting(false);
    setFormError(null);
    setFieldErrors({});
  }, [open]);

  /** 后端可能对通用字段报错，它们的路径不在 METADATA_SPECS 里 */
  const knownPaths = useMemo(() => {
    const specs = type === null ? [] : METADATA_SPECS[type];
    return new Set<string>([...GENERAL_FIELD_KEYS, ...fieldPaths(specs)]);
  }, [type]);

  async function submit(): Promise<void> {
    if (type === null || submitting) return;

    const trimmedName = name.trim();
    if (trimmedName === '') {
      // 前端拦一道只是为了少一次往返；后端同样会拒（`name` 有 min(1)）
      setFieldErrors({ name: '资产名称不能为空' });
      setFormError(null);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const created = await apiPost<AssetDetail>('/api/assets', {
        projectId,
        type,
        name: trimmedName,
        // 留空就不发这个键：发空串会占住 slug 的唯一性，发 null 会被 schema 拒
        ...(slug.trim() === '' ? {} : { slug: slug.trim() }),
        description,
        tags,
        ...(coverUrl.trim() === '' ? {} : { coverUrl: coverUrl.trim() }),
        // 只交用户真的填过的字段（详见文件头注释）
        metadata: diffMetadata(METADATA_SPECS[type], {}, metadata),
      });
      onCreated(created);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const parsed = parseFieldErrors(apiError?.suggestions ?? [], knownPaths);
      setFieldErrors(parsed.fieldErrors);
      setFormError({
        message: apiError?.message ?? '创建资产失败。',
        suggestions: parsed.unmatched,
      });
    } finally {
      setSubmitting(false);
    }
  }

  const typeLabel =
    CREATABLE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? '资产';

  return (
    <Dialog
      open={open}
      title={type === null ? '新建资产 · 选择类型' : `新建${typeLabel}`}
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          {type === null ? (
            <Button onClick={onClose}>取消</Button>
          ) : (
            <>
              <Button onClick={() => { setType(null); }} disabled={submitting}>
                换类型
              </Button>
              {/* 表单在 children 里，按钮在 footer 里，靠 form 属性关联 */}
              <Button variant="primary" type="submit" form="asset-create-form" loading={submitting}>
                创建
              </Button>
            </>
          )}
        </div>
      }
    >
      {type === null ? (
        <>
          <p className={styles.stepHint}>
            选一个类型。图片、视频这类「生成产物」不在这里新建 —— 它们由 Agent
            生成后自动入库，避免手填的数据与实际文件不符。
          </p>
          <ul className={styles.typeGrid}>
            {CREATABLE_TYPE_OPTIONS.map((option) => (
              <li key={option.value}>
                <Button
                  className={styles.typeButton}
                  onClick={() => {
                    setType(option.value);
                  }}
                >
                  {option.label}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <form
          id="asset-create-form"
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
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

          <div className={styles.general}>
            <Field
              label="名称"
              htmlFor="asset-create-name"
              {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
            >
              <input
                id="asset-create-name"
                type="text"
                value={name}
                disabled={submitting}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>

            <Field
              label="引用名"
              htmlFor="asset-create-slug"
              helper="在对话里用 @引用名 指定它。留空则按名称自动生成"
              {...(fieldErrors.slug !== undefined ? { error: fieldErrors.slug } : {})}
            >
              <input
                id="asset-create-slug"
                type="text"
                value={slug}
                disabled={submitting}
                onChange={(event) => {
                  setSlug(event.target.value);
                }}
              />
            </Field>

            <Field
              label="说明"
              htmlFor="asset-create-description"
              {...(fieldErrors.description !== undefined ? { error: fieldErrors.description } : {})}
            >
              <textarea
                id="asset-create-description"
                rows={2}
                value={description}
                disabled={submitting}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </Field>

            <TagsField
              label="标签"
              htmlFor="asset-create-tags"
              id="asset-create-tags"
              value={tags}
              disabled={submitting}
              helper="回车添加一项"
              {...(fieldErrors.tags !== undefined ? { error: fieldErrors.tags } : {})}
              onChange={setTags}
            />

            <Field
              label="封面图地址"
              htmlFor="asset-create-cover"
              helper="图片直链。留空则列表里用类型标签占位"
              {...(fieldErrors.coverUrl !== undefined ? { error: fieldErrors.coverUrl } : {})}
            >
              <input
                id="asset-create-cover"
                type="text"
                value={coverUrl}
                disabled={submitting}
                onChange={(event) => {
                  setCoverUrl(event.target.value);
                }}
              />
            </Field>
          </div>

          <MetadataForm
            specs={METADATA_SPECS[type]}
            value={metadata}
            onChange={setMetadata}
            errors={fieldErrors}
            disabled={submitting}
            idPrefix="asset-create"
          />
        </form>
      )}
    </Dialog>
  );
}
