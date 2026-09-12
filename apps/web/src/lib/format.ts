/**
 * 展示层格式化。
 *
 * 纯函数、无副作用、可注入 `now` —— 后者是为了让测试不依赖真实时钟。
 */

/** 相对时间。无法解析时返回空串：界面上宁可少一块信息，也不要显示 "Invalid Date"。 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return '';

  const diffMs = now.getTime() - target.getTime();

  // 客户端时钟比服务端快是常见现象，未来时间按「刚刚」处理而不是显示负数
  if (diffMs < 60_000) return '刚刚';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  // 超过一天就给绝对日期 —— 「3 天前」对用户没有「几号」有用
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(
    target.getDate(),
  ).padStart(2, '0')}`;
}

/** 耗时。小于一秒用毫秒，避免出现 "0.0s" 这种没有信息量的显示。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
