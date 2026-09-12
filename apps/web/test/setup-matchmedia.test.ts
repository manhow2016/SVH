/**
 * `test/setup.ts` 中 matchMedia 垫片的回归护栏。
 *
 * 存在的理由：垫片曾经写在 setup 文件的**顶层**，只在文件加载时执行一次；
 * 而同一个文件的 afterEach 会调用 vi.unstubAllGlobals()，由于 matchMedia
 * 在 jsdom 里原本不存在，Vitest 对这个属性走 Reflect.deleteProperty，
 * 桩被直接删除 —— 于是每个测试文件只有第一个用例受保护。
 *
 * 所以这里刻意放**多个**用例：第一个用例通过不足以说明问题，
 * 必须让第二个及之后的用例也断言 matchMedia 仍然可用。
 */
import { describe, expect, it, vi } from 'vitest';

/** 断言垫片可用，且默认按宽屏（matches === false）返回 */
function expectMatchMediaStubbed(): void {
  expect(typeof window.matchMedia).toBe('function');
  expect(window.matchMedia('(max-width: 1024px)').matches).toBe(false);
}

describe('setup.ts 的 matchMedia 垫片', () => {
  it('第一个用例内 matchMedia 可用', () => {
    expectMatchMediaStubbed();
  });

  it('第二个用例内 matchMedia 依然可用（不是只保护首个用例）', () => {
    expectMatchMediaStubbed();
  });

  it('第三个用例内 matchMedia 依然可用（连续多个用例后仍成立）', () => {
    expectMatchMediaStubbed();
  });

  it('用例内自行覆盖 matchMedia（模拟窄屏）', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(window.matchMedia('(max-width: 1024px)').matches).toBe(true);
  });

  it('承接上一个用例：覆盖已被 afterEach 复位，垫片重新装好且为宽屏', () => {
    expectMatchMediaStubbed();
  });
});
