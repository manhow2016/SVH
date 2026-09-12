/**
 * 统一 SVG 图标集。
 *
 * ── 为什么自建而不引图标库 ──
 * 项目规范禁止 emoji 与混用多个图标库。图标总量只有 12 个，
 * 自建可以保证线宽、圆角、viewBox 完全一致，也不引入一个只为 12 个图标存在的依赖。
 *
 * 颜色一律用 `currentColor`，让图标跟随所在文本的颜色，避免在每处调用点重复指定。
 */

/** 图标名。新增图标必须同时补进 PATHS，两者由类型与测试双重约束。 */
export const ICON_NAMES = [
  'folder',
  'plus',
  'send',
  'close',
  'chevron-down',
  'chevron-right',
  'check',
  'alert',
  'info',
  'play',
  'refresh',
  'settings',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** 24×24 viewBox 下的路径数据 */
const PATHS: Record<IconName, string> = {
  folder: 'M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  plus: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 16-2.5-6.5L4 12Z',
  close: 'M6 6l12 12M18 6L6 18',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  check: 'M4 12.5l5 5L20 6.5',
  alert: 'M12 4l9 16H3l9-16ZM12 10v5M12 18h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  play: 'M7 5l12 7-12 7V5Z',
  refresh: 'M20 11a8 8 0 1 0-1.5 5M20 5v6h-6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12c0-.5-.05-1-.14-1.47l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.55-1.47L13.6 2h-3.2l-.36 2.53a7 7 0 0 0-2.55 1.47L5.14 5.05l-2 3.46 2 1.55a7.1 7.1 0 0 0 0 2.94l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.55 1.47L10.4 22h3.2l.36-2.53a7 7 0 0 0 2.55-1.47l2.35.95 2-3.46-2-1.55c.09-.47.14-.97.14-1.47Z',
};

export interface IconProps {
  name: IconName;
  /** 边长，默认跟随当前字号 */
  size?: number;
  className?: string;
}

export function Icon({ name, size, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size ?? '1em'}
      height={size ?? '1em'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // 图标是装饰性的：语义由相邻文本承担，读屏重复朗读反而嘈杂
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
