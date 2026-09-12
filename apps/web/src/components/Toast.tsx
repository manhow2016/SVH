import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Icon, type IconName } from './Icon.js';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  error: 'alert',
};

/** 自动消失时长；错误留久一点，因为它更需要被读到 */
const DISMISS_MS: Record<ToastTone, number> = {
  info: 3000,
  success: 3000,
  error: 6000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  /*
   * 未触发的定时器必须有归属：否则 Provider 卸载后它们仍会跑一次 setItems。
   * 这里用 ref 持有全部待触发定时器，卸载时统一清掉。
   */
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, message, tone }]);
    const timer = setTimeout(() => {
      // 触发过的定时器及时从集合里摘掉，避免集合随会话无限增长
      timers.current.delete(timer);
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, DISMISS_MS[tone]);
    timers.current.add(timer);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        aria-live="polite"：让读屏在空闲时播报，而不是打断当前朗读。
        错误用 role="alert" 单独提升优先级。
      */}
      <div className={styles.viewport} aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={`${styles.toast} ${styles[item.tone]}`}
            role={item.tone === 'error' ? 'alert' : undefined}
          >
            <Icon name={TONE_ICON[item.tone]} />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 取用轻提示。必须在 ToastProvider 内调用，否则直接抛错而不是静默失效。 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return ctx;
}
