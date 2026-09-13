import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from './Button.js';
import { Icon } from './Icon.js';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  /** 打开前的焦点元素：关闭时还给它，否则键盘用户的焦点会掉回 body */
  const restoreRef = useRef<HTMLElement | null>(null);

  /** 最新的 onClose。放进 effect 依赖会让监听器在父组件每次重渲染时被重新注册 */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Esc 关闭：键盘用户必须能退出模态，否则会被困住
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // 打开时把焦点移进对话框，关闭时归还给触发元素（无障碍对话框的标准行为）
  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      // 点击遮罩关闭；阻止冒泡以免点击内容区也触发
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </Button>
        </div>
        <div>{children}</div>
        {footer !== undefined ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
