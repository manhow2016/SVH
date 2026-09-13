import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from './Button.js';
import { Icon } from './Icon.js';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  side?: 'left' | 'right';
  /** 宽度档位。`sm`（默认）320px，工作台侧区用；`lg` 560px，资产详情表单用 */
  width?: 'sm' | 'lg';
  children: ReactNode;
}

/**
 * 侧抽屉。窄屏时用来收纳工作台的侧区（项目/会话导航、任务面板），
 * 也用作资产详情的容器。
 *
 * 键盘可达性保证三件事，与 `Dialog` 一致：
 *   1. `Esc` 关闭；
 *   2. 打开时焦点进入面板（否则 Tab 会从页面开头重新走一遍，
 *      面板里的内容对键盘用户等于不存在）；
 *   3. 关闭后焦点还给触发元素（否则焦点掉回 `body`，键盘用户当场迷路）。
 *
 * 刻意**不**做焦点陷阱：面板之外的页面内容仍然可达，
 * 而 `aria-modal="true"` 已经把它标成了模态对话框。
 */
export function Drawer({
  open,
  title,
  onClose,
  side = 'right',
  width = 'sm',
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement>(null);
  /** 打开前的焦点元素：关闭时还给它 */
  const restoreRef = useRef<HTMLElement | null>(null);

  // Esc 关闭：键盘用户必须能退出模态，否则会被困住
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      /*
       * 只关「最上面那一层」。
       *
       * 抽屉里可能再叠一个 Dialog（归档二次确认就是），它也在 document 上监听 Esc。
       * 两个监听器都在 document 上，按注册顺序触发（抽屉先注册）—— 抽屉若照单全收，
       * 一次 Esc 会把确认框与抽屉一起关掉，用户刚填的东西跟着没了。
       * 判据用焦点：Dialog 打开时会把焦点移进自己的面板，所以
       * 「焦点落在另一个 role="dialog" 里」就等于「有模态叠在我上面」。
       */
      const active = document.activeElement;
      const owner = active instanceof Element ? active.closest('[role="dialog"]') : null;
      if (owner !== null && owner !== panel) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 打开时把焦点移进面板，关闭时归还给触发元素
  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} role="presentation" />
      <aside
        ref={panelRef}
        className={`${styles.panel} ${side === 'left' ? styles.left : styles.right} ${
          width === 'lg' ? styles.wide : ''
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // 宽度档位用 data 属性暴露：jsdom 看不见布局，只能断言这个
        data-width={width}
        // 面板本身不参与 Tab 序列，但要能被聚焦（`focus()` 需要）
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </Button>
        </div>
        {children}
      </aside>
    </>
  );
}
