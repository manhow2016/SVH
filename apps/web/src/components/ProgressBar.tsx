import styles from './ProgressBar.module.css';

export interface ProgressBarProps {
  /** 0~100；越界会被夹到区间内 */
  value: number;
  label?: string;
}

/** 把越界值夹到合法区间：后端理论上不会给越界值，但界面不该因此渲染出负宽度 */
function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function ProgressBar({ value, label }: ProgressBarProps) {
  const percent = clamp(value);
  return (
    <div className={styles.wrapper}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label ?? '进度'}
      >
        <div className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
      {label !== undefined ? <span className={styles.label}>{label}</span> : null}
    </div>
  );
}
