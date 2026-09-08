import { useEffect, useState } from "react";

/**
 * 响应式断点检测（默认 768px，与 index.css 的媒体查询保持一致）。
 * 用于 JS 分支渲染（顶栏菜单、弹窗移动端布局），CSS 类仍负责纯样式适配。
 */
export function useIsMobile(breakpoint = 768): boolean {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState<boolean>(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isMobile;
}
