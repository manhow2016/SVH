/**
 * 前端测试的公共装配。
 *
 * 做三件事：给断言库挂上 jest-dom 匹配器、补齐 jsdom 缺失的浏览器 API、
 * 保证每个用例结束后不残留被替换的全局对象（否则用例之间会互相污染）。
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/*
 * jsdom 不实现 matchMedia，而 Task 9 的 useIsNarrow 依赖它。
 * 不在这里补上的话，Task 9 一加进 AgentWorkspace，
 * Task 5 那些原本通过的用例会全部抛 TypeError。
 *
 * 默认按「宽屏」返回；需要窄屏的用例自行 vi.stubGlobal('matchMedia', ...) 覆盖。
 */
if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
