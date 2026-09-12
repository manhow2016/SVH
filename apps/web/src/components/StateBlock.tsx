import type { ReactNode } from 'react';

import { Button } from './Button.js';
import { Icon, type IconName } from './Icon.js';
import styles from './StateBlock.module.css';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}

/** 空状态。规范禁止空白页面：必须有图标、标题、说明，以及（若有）主操作。 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.block}>
      <Icon name={icon} className={styles.icon} size={28} />
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{description}</p>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  /** 发生了什么 */
  title: string;
  /** 可能原因 */
  reason: string;
  /** 下一步怎么做 */
  suggestions?: string[];
  onRetry?: () => void;
}

/**
 * 错误状态。规范要求错误信息必须说明「发生了什么 / 可能原因 / 下一步怎么做」，
 * 因此 `title` 与 `reason` 都是必填 —— 只写「出错了」的组件在这个类型下根本构造不出来。
 */
export function ErrorState({ title, reason, suggestions, onRetry }: ErrorStateProps) {
  return (
    <div className={styles.block} role="alert">
      <Icon name="alert" className={`${styles.icon} ${styles.errorIcon}`} size={28} />
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{reason}</p>
      {suggestions !== undefined && suggestions.length > 0 ? (
        <ul className={styles.suggestions}>
          {suggestions.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
      {/* 重试必须复用 Button：裸 <button> 会让全应用出现第二种按钮样式 */}
      {onRetry !== undefined ? (
        <Button variant="secondary" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 骨架行。形状贴合文字内容，让加载态与最终布局一致。
 *
 * `aria-busy` 放在真正承载内容的容器上（不再是 `aria-hidden` 的装饰元素 ——
 * 元素一旦整体移出无障碍树，`aria-busy` 就传达不了任何信息）；
 * 「正在加载」另由视觉隐藏的 `role="status"` 文本承担，读屏用户能直接听到。
 */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <>
      <span className={styles.srOnly} role="status">
        正在加载
      </span>
      <div className={styles.skeletonLines} aria-busy="true">
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            data-skeleton-line=""
            className={styles.skeletonLine}
            aria-hidden="true"
            // 末行短一些，更像真实段落
            style={index === lines - 1 ? { width: '60%' } : undefined}
          />
        ))}
      </div>
    </>
  );
}

/** 骨架块，用于媒体网格等非文字区域（加载语义同 `SkeletonLines`） */
export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return (
    <>
      <span className={styles.srOnly} role="status">
        正在加载
      </span>
      <div className={styles.skeletonBlock} style={{ height }} aria-busy="true" />
    </>
  );
}
