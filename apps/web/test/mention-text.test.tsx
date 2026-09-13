/**
 * `@资产` 文本解析与渲染测试。
 *
 * 这里守的是一条**宁可不可点，也不要链错**的原则，以及「渲染不能吃掉文字」——
 * 后者的失败形态是：一段好好的回复，因为其中一个 @ 命中，中间的逗号句号没了。
 * 所以最有力的一条断言是 `container.textContent` 与原文**逐字相同**。
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { MentionText } from '../src/features/assets/MentionText.js';

const INDEX = new Map([
  ['苏晚', 'a1'],
  ['长安城', 'a2'],
]);

function renderText(text: string, index: ReadonlyMap<string, string> = INDEX) {
  return render(
    <MemoryRouter>
      <MentionText text={text} assetIndex={index} projectId="p1" />
    </MemoryRouter>,
  );
}

describe('MentionText', () => {
  it('命中的 @名字 变成指向资产详情的链接', () => {
    renderText('先定 @苏晚 的外观');
    expect(screen.getByRole('link', { name: '@苏晚' })).toHaveAttribute(
      'href',
      '/projects/p1/assets?asset=a1',
    );
  });

  it('渲染后的可见文字与原文逐字相同（不多不少）', () => {
    const text = '让 @苏晚 在 @长安城 走，@张三 不来。';
    const { container } = renderText(text);
    expect(container.textContent).toBe(text);
  });

  it('未命中的引用保持纯文本，绝不链错', () => {
    renderText('参考 @张三 的风格');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/参考 @张三 的风格/)).toBeInTheDocument();
  });

  it('一段文字里的多个引用都成链', () => {
    renderText('@苏晚 在 @长安城');
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('索引为空时整段原样返回（降级路径）', () => {
    const { container } = renderText('先定 @苏晚 的外观', new Map());
    expect(container.textContent).toBe('先定 @苏晚 的外观');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('与后端同一条正则：`a@b.com` 里的 @b 同样算引用', () => {
    /*
     * 这条断言是把「前后端口径一致」明文写下来。
     * `apps/api/src/core/slug.ts` 的 `parseAssetMentions` 用同一条正则，
     * 所以后端**本来就会**把 `@b` 当成引用去解析。若将来想让邮箱不误链，
     * 必须两边一起改 —— 只改前端会让「后端认得的引用」在界面上点不开。
     */
    renderText('联系 a@b.com', new Map([['b', 'a9']]));
    expect(screen.getByRole('link', { name: '@b' })).toBeInTheDocument();
  });

  it('正文里没有 @ 时不做任何包装', () => {
    const { container } = renderText('好的，我先把分镜列出来。');
    expect(container.textContent).toBe('好的，我先把分镜列出来。');
  });
});
