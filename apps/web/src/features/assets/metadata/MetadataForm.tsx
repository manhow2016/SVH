/**
 * 资产 metadata 的通用渲染器。
 *
 * ── 一个渲染器，6 种控件 ──
 * 字段描述来自 `specs.ts` 的 `METADATA_SPECS`（**数据**），这里只负责把描述
 * 渲染成控件、把用户的编辑写回一个 `Record<string, unknown>`。
 * 新增类型或字段不需要动这个文件 —— 这正是「数据表 + 一个渲染器」的意义。
 *
 * ── 受控组件，但**不**自己算补丁 ──
 * 这里只维护「当前值」并向上 `onChange`；「哪些字段变了」由 `diffMetadata`
 * 在提交那一刻计算。分开的理由有两条：
 *   1. 补丁的正确性（清空发 `null`、数组整体替换、group 不整体置 null）是纯逻辑，
 *      值得单独测，不该埋在渲染里；
 *   2. 值留在表单内部，提交失败时用户的输入天然保留 —— 不需要额外写「恢复草稿」。
 */
import { useState, type ReactNode } from 'react';

import { Field } from '../../../components/Field.js';
import { Icon } from '../../../components/Icon.js';
import type { FieldSpec } from './specs.js';
import styles from './MetadataForm.module.css';

/** 非 group 的字段（叶子） */
type LeafSpec = Exclude<FieldSpec, { kind: 'group' }>;

/**
 * `Field` 通过 `cloneElement` 透到子元素上的无障碍属性。
 *
 * ── 为什么这里必须显式接住 ──
 * `Field` 的 children 是 `<LeafControl …/>` —— 一个**自定义组件**，不是 DOM
 * 节点。`cloneElement` 把这两个属性作为 **props** 交给它，而不是落到 DOM 上；
 * 组件若不往下传，`aria-describedby` / `aria-invalid` 就停在组件这一层，
 * 读屏用户聚焦输入框时听不到说明与错误，`Field` 的契约也就白写了。
 * （与 `components/Field.tsx` 里那份同名类型是一份口头契约：那边改传什么，
 * 这边就得接什么。）
 */
interface ControlAriaProps {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export interface MetadataFormProps {
  specs: readonly FieldSpec[];
  /** 表单覆盖的 metadata 子树，键与 specs 对齐 */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** 后端字段级错误，键是 `appearance.hair` 这样的点分路径 */
  errors?: Record<string, string>;
  /** 提交中：控件禁用，避免改到一半又被提交一次 */
  disabled?: boolean;
  /** 控件 id 前缀，同一页面出现两个表单时避免 id 冲突 */
  idPrefix: string;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 文本控件写回：**空串必须回落到 `undefined`**。
 *
 * `diffMetadata` 只把 `undefined` 认作「清空」（原本有值 → 提交 `null`）；
 * 直接写回 `''` 会被当成「用户把它改成了空字符串」，于是清空一个字段之后
 * 服务端留下一个空串而不是删掉它 —— 与下拉的「未设置」行为不一致。
 *
 * 判据只用 `=== ''`，**不 trim**：受控输入每次按键都要原样回写，
 * 一旦 trim 掉尾部空格，用户就再也打不出「你好 世界」这种中间带空格的句子。
 */
function textOrUndefined(raw: string): string | undefined {
  return raw === '' ? undefined : raw;
}

/**
 * 数字控件的显示值：**从数字反推**。
 *
 * ── 这样反推能不能输入小数 ──
 * 能。真机实测（`~/svh-probe/phase6/number-typing.mjs`，Chromium + CDP 真实按键）：
 * 逐字键入 `1` `.` `5` 最终得到 `1.5`。原因是输入 `1.` 时浏览器把 `.value` 报成
 * **上一次的合法值 `1`**，于是 React 的目标值与 DOM 当前值相等、**跳过写回**，
 * 原始文本 `1.` 留在编辑缓冲里，继续打 `5` 就成了 `1.5`。负数同理。
 *
 * **jsdom 不是这样**：`input.value = '1.'` 在 jsdom 30 里读回 `''`，受控重写
 * 于是会把小数点抹掉 —— 在 jsdom 里输入 `1.5` 会得到 `5`。所以小数输入
 * **在单元测试里测不出来**，它由上面那个真机探针保证。不要因为 jsdom 的症状
 * 去「修」这个实现。
 */
function numberTextOf(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** 空串回落到 `undefined`：diffMetadata 靠它区分「没填」与「填了空」 */
function numberOf(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringListOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 在对象里写一个键。不可变更新：React 靠引用变化决定重渲染 */
function withKey(
  source: Record<string, unknown>,
  key: string,
  next: unknown,
): Record<string, unknown> {
  return { ...source, [key]: next };
}

interface TagsInputProps extends ControlAriaProps {
  id: string;
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}

/**
 * 数组型字段的输入框。
 *
 * 输入框本身只承载「待确认的一项」，已确认的项渲染成 chips。
 * **失焦即提交**：用户打完一项直接点「保存」是常规操作，
 * 只在回车时提交会让这一项静默丢失（保存成功、数据却没进去）。
 */
function TagsInput({ id, value, disabled, onChange, ...aria }: TagsInputProps) {
  const [draft, setDraft] = useState('');

  function addTag(raw: string): void {
    const tag = raw.trim();
    setDraft('');
    if (tag === '' || value.includes(tag)) return;
    onChange([...value, tag]);
  }

  return (
    <input
      id={id}
      type="text"
      value={draft}
      disabled={disabled}
      // 与 LeafControl 同理：Field 的 children 是自定义组件，aria 属性必须显式往下传
      {...aria}
      onChange={(event) => {
        const next = event.target.value;
        // 逗号（含中文全角）当分隔符：中文输入法下用户会习惯性打「，」
        if (next.endsWith(',') || next.endsWith('，')) {
          addTag(next.slice(0, -1));
          return;
        }
        setDraft(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          // 回车在表单里默认是提交；标签输入框里它应当是「添加这一项」
          event.preventDefault();
          addTag(draft);
        }
      }}
      onBlur={() => {
        addTag(draft);
      }}
    />
  );
}

export interface TagsFieldProps {
  label: string;
  /** 必须与 `id` 一致 */
  htmlFor: string;
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  helper?: string;
  error?: string;
  disabled?: boolean;
}

/**
 * 数组型字段的完整控件（Label + Input + chips）。
 *
 * 导出它是为了通用字段 `tags`：创建对话框与详情抽屉上也有一个标签输入框，
 * 与 metadata 里的数组字段是**同一种交互**，必须长得一模一样。
 * 让它们各自实现一遍，两处迟早会长歪。
 */
export function TagsField({
  label,
  htmlFor,
  id,
  value,
  onChange,
  helper,
  error,
  disabled = false,
}: TagsFieldProps) {
  return (
    // 结构刻意是 `Field > TagsInput`（单个元素）+ 同级的 chips：
    // Field 用 cloneElement 把 aria-describedby / aria-invalid 透到**单个**子元素上。
    // 若子元素换成包着 chips 的 div，这两个属性会落在 div 上。
    // 注意 `TagsInput` 是**自定义组件**而不是 DOM 节点 —— 所以它必须
    // 继承 `ControlAriaProps` 并把 `{...aria}` 展开到真实的 input 上，
    // 否则属性停在组件这一层，界面上完全看不出来。
    <div className={styles.tags}>
      <Field
        label={label}
        htmlFor={htmlFor}
        {...(helper !== undefined ? { helper } : {})}
        {...(error !== undefined ? { error } : {})}
      >
        <TagsInput id={id} value={value} disabled={disabled} onChange={onChange} />
      </Field>
      {value.length > 0 ? (
        <ul className={styles.chipList}>
          {value.map((tag) => (
            <li className={styles.chip} key={tag}>
              <span>{tag}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`删除 ${tag}`}
                disabled={disabled}
                onClick={() => {
                  onChange(value.filter((item) => item !== tag));
                }}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface LeafProps extends ControlAriaProps {
  spec: LeafSpec;
  id: string;
  value: unknown;
  disabled: boolean;
  onChange: (next: unknown) => void;
}

/** 一个叶子字段的控件。tags 单独处理（要 chips，见 MetadataForm 里的说明） */
function LeafControl({ spec, id, value, disabled, onChange, ...aria }: LeafProps) {
  switch (spec.kind) {
    case 'text':
      return (
        <input
          id={id}
          type="text"
          value={textOf(value)}
          disabled={disabled}
          // Field 透下来的 aria-describedby / aria-invalid 必须落到真实的控件上
          {...aria}
          onChange={(event) => {
            onChange(textOrUndefined(event.target.value));
          }}
        />
      );
    case 'textarea':
      return (
        <textarea
          id={id}
          rows={3}
          value={textOf(value)}
          disabled={disabled}
          {...aria}
          onChange={(event) => {
            onChange(textOrUndefined(event.target.value));
          }}
        />
      );
    case 'number':
      return (
        <input
          id={id}
          type="number"
          step="any"
          value={numberTextOf(value)}
          disabled={disabled}
          {...aria}
          onChange={(event) => {
            onChange(numberOf(event.target.value));
          }}
        />
      );
    case 'select':
      return (
        <select
          id={id}
          value={textOf(value)}
          disabled={disabled}
          {...aria}
          onChange={(event) => {
            // 空值选项 = 清空：回落到 undefined，由 diffMetadata 决定发不发 null
            onChange(event.target.value === '' ? undefined : event.target.value);
          }}
        >
          <option value="">未设置</option>
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'tags':
      // 由调用方渲染（要连同 chips 一起），这里不可达
      return null;
  }
}

export function MetadataForm({
  specs,
  value,
  onChange,
  errors = {},
  disabled = false,
  idPrefix,
}: MetadataFormProps) {
  /**
   * 递归渲染一层字段。
   *
   * `emit` 是**这一层**的写回函数：顶层就是 `onChange`，group 内部则是
   * 「把改动重新套回 group 的键」的那一层包装。少了这层包装，group 里的
   * 一次编辑会把整个 metadata 替换成那个子对象 —— 外层的键全丢。
   */
  const renderNodes = (
    nodes: readonly FieldSpec[],
    parent: Record<string, unknown>,
    prefix: string,
    emit: (next: Record<string, unknown>) => void,
  ): ReactNode[] =>
    nodes.map((spec) => {
      const path = prefix === '' ? spec.key : `${prefix}.${spec.key}`;
      const id = `${idPrefix}-${path}`;
      const raw = parent[spec.key];

      if (spec.kind === 'group') {
        return (
          <fieldset className={styles.group} key={spec.key}>
            <legend className={styles.legend}>{spec.label}</legend>
            {spec.help !== undefined ? <p className={styles.groupHelp}>{spec.help}</p> : null}
            {/* group 自身的错误（例如整个对象类型不对）也要有地方显示，不能吞掉 */}
            {errors[path] !== undefined ? (
              <p className={styles.groupError} role="alert">
                {errors[path]}
              </p>
            ) : null}
            <div className={styles.fields}>
              {renderNodes(spec.fields, objectOf(raw), path, (nextSub) => {
                emit(withKey(parent, spec.key, nextSub));
              })}
            </div>
          </fieldset>
        );
      }

      const error = errors[path];

      if (spec.kind === 'tags') {
        return (
          <TagsField
            key={spec.key}
            label={spec.label}
            htmlFor={id}
            id={id}
            value={stringListOf(raw)}
            disabled={disabled}
            {...(spec.help !== undefined ? { helper: spec.help } : {})}
            {...(error !== undefined ? { error } : {})}
            onChange={(next) => {
              emit(withKey(parent, spec.key, next));
            }}
          />
        );
      }

      return (
        <Field
          key={spec.key}
          label={spec.label}
          htmlFor={id}
          {...(spec.help !== undefined ? { helper: spec.help } : {})}
          {...(error !== undefined ? { error } : {})}
        >
          <LeafControl
            spec={spec}
            id={id}
            value={raw}
            disabled={disabled}
            onChange={(next) => {
              emit(withKey(parent, spec.key, next));
            }}
          />
        </Field>
      );
    });

  return <div className={styles.form}>{renderNodes(specs, value, '', onChange)}</div>;
}
