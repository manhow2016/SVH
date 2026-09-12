/**
 * Design Token 契约测试。
 *
 * 这些断言的意义不是「测试 CSS」，而是**把 Token 的完整性钉住**：
 * 组件靠这些变量名取色取字号，变量一旦改名或被删，组件会静默回退到浏览器默认样式 ——
 * 界面坏了但构建不会失败。这里让构建失败。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * 这里刻意不用 `new URL('../src/styles/tokens.css', import.meta.url)`：
 * jsdom 环境会替换掉全局 `URL`，相对路径会按 jsdom 文档地址
 * （http://localhost:3000/）解析，协议不再是 file:，readFileSync 随即抛
 * 「The URL must be of scheme file」。先取文件路径再拼绝对路径可绕开这一点。
 */
const tokensPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/tokens.css');
const tokens = readFileSync(tokensPath, 'utf8');

/** 断言某个 Token 存在 */
function expectToken(name: string): void {
  expect(tokens, `缺少 Design Token ${name}`).toContain(`${name}:`);
}

describe('Design Token', () => {
  it('包含全部颜色语义档位', () => {
    for (const name of [
      '--color-background',
      '--color-surface',
      '--color-surface-secondary',
      '--color-border',
      '--color-text-primary',
      '--color-text-secondary',
      '--color-text-tertiary',
      '--color-primary',
      '--color-success',
      '--color-warning',
      '--color-error',
    ]) {
      expectToken(name);
    }
  });

  it('包含七级字号层级', () => {
    for (const name of [
      '--font-size-page-title',
      '--font-size-section',
      '--font-size-card-title',
      '--font-size-body',
      '--font-size-secondary',
      '--font-size-caption',
      '--font-size-button',
    ]) {
      expectToken(name);
    }
  });

  it('间距只有九档，且都是 4 的倍数', () => {
    const spacing = [...tokens.matchAll(/--space-(\d+):\s*(\d+)px/g)];
    expect(spacing).toHaveLength(9);
    for (const [, , px] of spacing) {
      expect(Number(px) % 4).toBe(0);
    }
  });

  it('圆角只有四档', () => {
    const radii = [...tokens.matchAll(/--radius-[a-z]+:/g)];
    expect(radii).toHaveLength(4);
  });

  it('不包含被明令禁止的视觉效果', () => {
    // 渐变与玻璃拟态在规范里是明确禁止的，用测试挡住「顺手加一个」
    expect(tokens).not.toMatch(/linear-gradient|radial-gradient/);
    expect(tokens).not.toMatch(/backdrop-filter/);
  });
});
