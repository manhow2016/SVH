/**
 * 前端测试的公共装配。
 *
 * 做三件事：给断言库挂上 jest-dom 匹配器、补齐 jsdom 缺失的浏览器 API、
 * 保证每个用例结束后不残留被替换的全局对象（否则用例之间会互相污染）。
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/*
 * jsdom 不实现 matchMedia，而 Task 9 的 useIsNarrow 依赖它。
 * 不在这里补上的话，Task 9 一加进 AgentWorkspace，
 * Task 5 那些原本通过的用例会全部抛 TypeError。
 *
 * 默认按「宽屏」返回；需要窄屏的用例自行 vi.stubGlobal('matchMedia', ...) 覆盖。
 *
 * 注意：桩必须每个用例装一次，不能只在文件顶层装一次 ——
 * 下面的 afterEach 会调用 vi.unstubAllGlobals()，而 matchMedia 是 jsdom 里
 * 原本不存在的属性，Vitest 对它走 Reflect.deleteProperty，即把桩**直接删掉**。
 * 放在顶层只会保护每个文件的第一个用例，第二个用例起 matchMedia 又变回 undefined。
 */
beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
