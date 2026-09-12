import { cloneElement, isValidElement, type ReactNode } from 'react';

import styles from './Field.module.css';

/** 需要透到子控件上的无障碍属性 */
interface ControlAriaProps {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export interface FieldProps {
  label: string;
  /** 必须与内部控件的 id 一致，否则 label 与控件不会关联 */
  htmlFor: string;
  helper?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, helper, error, children }: FieldProps) {
  const hasError = error !== undefined;
  // 有 error 时不显示 helper：两句并存会让用户不知道该看哪一句
  const messageId = hasError ? `${htmlFor}-error` : `${htmlFor}-helper`;
  const hasMessage = hasError || helper !== undefined;

  /*
   * aria-describedby / aria-invalid 必须落在**真正的控件**上 ——
   * 只把说明文字渲染在旁边，读屏用户是听不到的。
   *
   * 约束：只有 children 是**单个元素**时才能透传。若调用方传了字符串、多个元素
   * 或 Fragment，这里退化为「照常渲染说明文字但不透传」——文案不会丢，只是不带
   * 无障碍关联。此时正确做法是调用方用 `<label>` 包住控件自行关联。
   * 这两个属性的所有者是 Field：子控件若自行设置会被覆盖。
   */
  const control =
    hasMessage && isValidElement<ControlAriaProps>(children)
      ? cloneElement(children, {
          'aria-describedby': messageId,
          'aria-invalid': hasError ? true : undefined,
        })
      : children;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      <div className={styles.control}>{control}</div>
      {hasError ? (
        <span className={styles.error} id={messageId} role="alert">
          {error}
        </span>
      ) : helper !== undefined ? (
        <span className={styles.helper} id={messageId}>
          {helper}
        </span>
      ) : null}
    </div>
  );
}
