/**
 * 输入区测试。
 *
 * 最关键的一条：**发送失败不能清空输入框**。
 * 用户可能刚敲了两百字的需求，一次网络抖动就把它清掉是不可接受的。
 */
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '../src/features/agent/Composer.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/*
 * 这些用例要穿过「fetch → ReadableStream 解析 / 两步 REST 加载 → React 状态更新」
 * 好几段异步，默认 1 秒的等待上限在机器有负载时会随机不够 ——
 * 那是会伪装成功能缺陷的假红，因此统一放宽到 5 秒（真失败仍会被断言抓住）。
 */
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 让引用解析请求成功返回空匹配。
 *
 * **每次发送前都会先调 `/api/assets/resolve-mentions`**，
 * 因此任何断言「onSend 被调用」的用例都必须先把这个请求接住 ——
 * 否则解析失败会让 submit 走进 catch，onSend 根本不会被调用。
 *
 * 注意这里用 `mockImplementation` 而**不是** `mockResolvedValue`：
 * 后者会让每次请求共用同一个 `Response` 实例，而响应体只能读一次 ——
 * 第二个请求（引用解析）会拿到一个 body 已被消费的 Response 并直接抛错，
 * 用例就会以「onSend 没被调用」这种与预期完全无关的原因失败。
 */
function stubResolve(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mentions: [], matched: [], missing: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

describe('Composer', () => {
  it('Enter 发送，Shift+Enter 换行', async () => {
    stubResolve();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, '做一个广告');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('做一个广告', []));

    await userEvent.type(textarea, '第一行');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    // Shift+Enter 不触发发送
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('把命中的 @引用 换成真实资产 id 一并发送', async () => {
    /*
     * 两条请求都要接住，且**每条都返回新的 Response**：
     * 输入 `@` 会先打资产列表端点，发送前再打引用解析端点 ——
     * 用 `mockResolvedValue` 复用同一个 Response 时，第二次读取会抛
     * 「Body is unusable」，用例会以无关原因失败（详见 stubResolve 的注释）。
     */
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url === '/api/assets/resolve-mentions'
            ? json({
                mentions: ['苏晚'],
                matched: [{ id: 'asset_1', slug: 'su-wan', name: '苏晚' }],
                missing: [],
              })
            : json({ items: [], total: 0, page: 1, pageSize: 50, hasMore: false }),
        ),
      ),
    );
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);

    await userEvent.type(screen.getByRole('textbox'), '@苏晚 穿红色衣服');
    await userEvent.keyboard('{Enter}');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('@苏晚 穿红色衣服', ['asset_1']),
    );
  });

  it('空输入不发送', async () => {
    stubResolve();
    const onSend = vi.fn();
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);
    await userEvent.type(screen.getByRole('textbox'), '   ');
    await userEvent.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('发送失败时保留输入内容', async () => {
    stubResolve();
    const onSend = vi.fn().mockRejectedValue(new Error('网络错误'));
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, '一段很长的需求描述');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // 内容必须还在 —— 一次失败就清空是不可接受的
    expect(screen.getByRole('textbox')).toHaveValue('一段很长的需求描述');
  });

  it('输入 / 时列出技能', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          items: [
            { id: 'script.generate', name: '脚本生成', category: 'text' },
            { id: 'image.generate', name: '图片生成', category: 'image' },
          ],
          total: 2,
        }),
      ),
    );

    render(<Composer projectId="p1" onSend={vi.fn()} disabled={false} />);
    await userEvent.type(screen.getByRole('textbox'), '/');

    expect(await screen.findByText('脚本生成')).toBeInTheDocument();
    expect(screen.getByText('图片生成')).toBeInTheDocument();
  });

  it('disabled 时不可输入', () => {
    render(<Composer projectId="p1" onSend={vi.fn()} disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('词中间的 / 与 @ 不触发补全，也不会劫持 Enter', async () => {
    /*
     * `A/B 测试`、`a@b.com` 不是引用意图。若只看最后一个字符就弹补全，
     * 紧接着的 Enter 会去选中列表项而不是发送 —— 用户写的一整句会被替换掉。
     */
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url === '/api/assets/resolve-mentions'
          ? json({ mentions: [], matched: [], missing: [] })
          : json({ items: [{ id: 'script.generate', name: '脚本生成' }], total: 1 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);

    await userEvent.type(screen.getByRole('textbox'), 'A/B 测试 a@b.com');
    // 一次补全请求都不该发出去
    expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain('/api/skills?pageSize=50');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('A/B 测试 a@b.com', []));
  });

  it('发送中禁用输入，并提供可中断的停止入口', async () => {
    stubResolve();

    // 手动控制这一轮的成败：停止按钮要能在请求未返回时把它中断
    let failSend: ((reason: Error) => void) | null = null;
    const onSend = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSend = reject;
        }),
    );
    const onCancel = vi.fn(() => {
      failSend?.(new Error('已中断'));
    });

    render(
      <Composer projectId="p1" onSend={onSend} disabled={false} onCancel={onCancel} />,
    );

    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, '一段需求');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalled());

    // 发送中：输入禁用（不能改一份正在发出去的文本）
    expect(screen.getByRole('textbox')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '停止生成' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    // 中断按失败处理：回到可编辑状态，且内容仍在
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    expect(screen.getByRole('textbox')).toHaveValue('一段需求');
  });
});
