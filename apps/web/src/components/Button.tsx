import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Icon } from './Icon.js';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * 视觉优先级。默认 `secondary` 是**刻意的**：
   * 规范要求「一个操作区域原则上只有一个 Primary Action」，
   * 默认值不设为 primary，可以避免调用方随手写个按钮就把主次关系破坏掉。
   */
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  // 调用方传入的 className 必须拼接保留：类型上声明支持却被静默吞掉，会让调用点莫名失效
  const classes = [styles.button, styles[variant], size === 'sm' ? styles.sm : undefined, className]
    .filter((name) => name !== undefined && name !== '')
    .join(' ');

  return (
    <button
      {...rest}
      type={rest.type ?? 'button'}
      className={classes}
      // 用 data 属性暴露 variant 供测试与样式钩子使用，避免测试去断言类名
      data-variant={variant}
      // loading 必须真的把按钮禁用掉：只加 aria-busy 的话按钮仍可点击，会重复提交
      disabled={disabled === true || loading}
      aria-busy={loading ? 'true' : undefined}
    >
      {loading ? <Icon name="refresh" /> : null}
      {children}
    </button>
  );
}
