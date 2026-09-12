import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '../../components/Button.js';
import { Icon } from '../../components/Icon.js';
import { useToast } from '../../components/Toast.js';
import { apiFetch, apiPost } from '../../lib/api.js';
import styles from './Composer.module.css';

export interface ComposerProps {
  projectId: string;
  /** 发送消息。抛错表示失败，此时输入内容必须保留 */
  onSend: (message: string, referencedAssetIds: string[]) => Promise<void>;
  disabled: boolean;
  /**
   * 中断在途发送。
   *
   * 不传就没有停止入口 —— 中断能力在调用方手里（它持有 AbortController），
   * 输入区只负责把用户的意图传出去。
   */
  onCancel?: () => void;
}

interface SkillOption {
  id: string;
  name: string;
  category: string;
}

interface AssetOption {
  id: string;
  slug: string;
  name: string;
}

type Suggestion =
  | { kind: 'skill'; id: string; label: string; meta: string }
  | { kind: 'asset'; id: string; label: string; meta: string };

export function Composer({ projectId, onSend, disabled, onCancel }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { show: toast } = useToast();

  /*
   * 输入框随内容长高，超过 CSS 的 max-height 后转为内部滚动。
   *
   * 不做的话，多行需求会被挤在一行里滚动着写 —— 用户看不见自己写了什么。
   * jsdom 不实现布局（scrollHeight 恒为 0）：那里回落到 CSS 的 min-height，
   * 因此这个副作用在测试环境里是安全的空操作。
   */
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null) return;
    node.style.height = 'auto';
    const measured = node.scrollHeight;
    if (measured > 0) node.style.height = `${String(measured)}px`;
  }, [text]);

  const loadSuggestions = useCallback(
    async (kind: '/' | '@') => {
      try {
        /*
         * 补给列表的两条响应都做**存在性兜底**：`items` 缺失时按空列表处理。
         * 补全数据是「锦上添花」，一个形状不符的响应不该让输入区抛异常 ——
         * 这里的 catch 只该兜网络失败，不该替后端兜协议。
         */
        if (kind === '/') {
          const page = await apiFetch<{ items?: SkillOption[] }>('/api/skills?pageSize=50');
          const items = Array.isArray(page.items) ? page.items : [];
          setSuggestions(
            items.map((skill) => ({
              kind: 'skill' as const,
              id: skill.id,
              label: skill.name,
              meta: skill.id,
            })),
          );
        } else {
          const page = await apiFetch<{ items?: AssetOption[] }>(
            `/api/projects/${projectId}/assets?pageSize=50`,
          );
          const items = Array.isArray(page.items) ? page.items : [];
          setSuggestions(
            items.map((asset) => ({
              kind: 'asset' as const,
              id: asset.id,
              label: asset.name,
              meta: `@${asset.slug}`,
            })),
          );
        }
        setActiveIndex(0);
      } catch {
        // 补全失败不该打断输入：静默收起列表即可
        setSuggestions([]);
      }
    },
    [projectId],
  );

  function handleChange(value: string): void {
    setText(value);

    /*
     * 触发补全的条件是「行首或空白之后的 / 与 @」。
     *
     * 为什么不能只看最后一个字符：`A/B 测试`、`a@b.com` 这类写法里触发符
     * 出现在词中间，并不是引用意图 —— 而补全列表一旦弹出，
     * 下一次 Enter 会去**选中列表项**而不是发送，用户刚写的整句话就被替换掉了。
     */
    const lastChar = value.slice(-1);
    const preceding = value.slice(0, -1);
    const atBoundary = preceding.length === 0 || /\s$/.test(preceding);
    if (atBoundary && (lastChar === '/' || lastChar === '@')) {
      void loadSuggestions(lastChar);
      return;
    }
    // 一旦输入了空白就收起补全
    if (/\s$/.test(value)) {
      setSuggestions([]);
    }
  }

  function applySuggestion(item: Suggestion): void {
    // 把触发符与其后的内容一起替换成选中的项
    const withoutTrigger = text.replace(/[/@][^\s/@]*$/, '');
    /*
     * 插入的是 **slug**（资产）或技能 id，而不是展示名：
     * `POST /api/assets/resolve-mentions` 是按 slug 匹配的
     * （见 apps/api/src/routes/assets.ts 与 core/slug.ts —— slug 保留中文，
     * 因此补全出来的 `@苏晚` 与用户手敲的写法完全一致）。
     */
    const inserted = item.kind === 'skill' ? `/${item.meta} ` : `@${item.meta.replace(/^@/, '')} `;
    setText(`${withoutTrigger}${inserted}`);
    setSuggestions([]);
  }

  async function submit(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;

    setSending(true);
    try {
      /*
       * 引用解析交给后端：前端不维护「引用名 → id」映射，避免两处口径不一致。
       *
       * 响应形状是 `{ mentions, matched, missing }`（已核对 apps/api/src/routes/assets.ts）：
       * `matched` 是命中的资产，`missing` 是文本里出现但项目内不存在的引用名。
       * 这里**只取 matched**，不因 missing 而阻止发送 ——
       * 「@不存在的角色」由 Agent 在对话里回答（它会明确说「我没有找到 @X」），
       * 前端再拦一道只会产生两条重复的提示。
       *
       * ── 为什么解析自成一个 try ──
       * 解析失败时 `onSend` **根本不会被调用**，调用方因此没有任何提示的机会。
       * 与发送共用一个 catch 的话，用户按 Enter 后只会看到输入框毫无变化 ——
       * 而这正是「失败必须可见」要消灭的形态。这条路径的提示只可能由本组件给出。
       */
      let matchedIds: string[] = [];
      try {
        const resolved = await apiPost<{ matched?: Array<{ id: string }> }>(
          '/api/assets/resolve-mentions',
          { projectId, text: trimmed },
        );
        const matched = Array.isArray(resolved.matched) ? resolved.matched : [];
        matchedIds = matched.map((asset) => asset.id);
      } catch {
        /*
         * 提示要同时说清三件事：发生了什么（引用解析失败）、
         * 结果是什么（消息没有发出去，而不是发出去了一半）、下一步怎么做（重试）。
         * 输入内容一律保留，用户按一次 Enter 就能重来。
         */
        toast('引用解析失败，消息没有发出去。输入已保留，请重试。', 'error');
        return;
      }

      try {
        await onSend(trimmed, matchedIds);
        // 只有成功才清空
        setText('');
        setSuggestions([]);
      } catch {
        /*
         * 失败时**保留**输入内容：用户可能刚敲了两百字的需求，
         * 一次网络抖动就把它清掉是不可接受的。
         *
         * 这条路径的可见提示由调用方负责（它才知道失败的原因，也已经弹过一次），
         * 这里刻意不吞也不改写成第二份文案 —— 再加一条会让一次失败弹两次。
         */
      }
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const picked = suggestions[activeIndex];
        if (picked !== undefined) applySuggestion(picked);
        return;
      }
      if (event.key === 'Escape') {
        setSuggestions([]);
        return;
      }
    }

    // Enter 发送，Shift+Enter 换行
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className={styles.wrapper}>
      {suggestions.length > 0 ? (
        <div className={styles.suggestions} role="listbox" aria-label="补全建议">
          {suggestions.map((item, index) => (
            <button
              key={`${item.kind}-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`${styles.suggestion} ${index === activeIndex ? styles.suggestionActive : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => applySuggestion(item)}
            >
              <span>{item.label}</span>
              <span className={styles.suggestionMeta}>{item.meta}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.row}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={text}
          disabled={disabled || sending}
          placeholder="描述你想创作的内容。输入 / 选择技能，输入 @ 引用资产"
          aria-label="需求输入"
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <Button
          variant="primary"
          loading={sending}
          disabled={disabled || text.trim().length === 0}
          onClick={() => {
            void submit();
          }}
          aria-label="发送"
        >
          <Icon name="send" />
        </Button>
        {/*
          发送中必须给出中断入口：一轮生成可能跑几十秒，
          没有停止按钮时用户唯一能做的是刷新页面 —— 那会丢掉这一轮上下文。
        */}
        {sending && onCancel !== undefined ? (
          <Button variant="secondary" onClick={onCancel} aria-label="停止生成">
            <Icon name="close" />
          </Button>
        ) : null}
      </div>

      <span className={styles.hint}>Enter 发送 · Shift + Enter 换行</span>
    </div>
  );
}
